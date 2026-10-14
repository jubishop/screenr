import Foundation
import Synchronization

// Sends Screenr API requests. Views and view models depend on this protocol,
// so tests can replace the client with a fake.
public protocol ScreenrAPI: Sendable {
  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response
}

// The Screenr API client. Every request sends:
// - `Authorization: Bearer <token>` while signed in, and never cookies or an
//   Origin.
// - `Screenr-Client: ios/<version>/<build>`, which the server checks against
//   its minimum build.
// - A new `Screenr-Request-Id`, which errors and the observer report.
// GET responses are cached in memory with their ETags. A repeated GET sends
// its ETag, and a 304 returns the cached value.
public final class ScreenrClient: ScreenrAPI {
  private struct CachedRead: Sendable {
    let etag: String
    let value: any Sendable
  }

  private let serverURL: URL
  private let clientHeader: String
  private let session: SessionStore
  private let transport: any HTTPTransport
  private let observer: (any APIRequestObserver)?
  // Keyed by path and query, such as `/api/screenr/screen?path=%2F`.
  private let cache = Mutex<[String: CachedRead]>([:])

  // `clientHeader` is `AppConfiguration.clientHeader`.
  public init(
    serverURL: URL,
    clientHeader: String,
    session: SessionStore,
    transport: any HTTPTransport = URLSessionTransport(),
    observer: (any APIRequestObserver)? = nil
  ) {
    self.serverURL = serverURL
    self.clientHeader = clientHeader
    self.session = session
    self.transport = transport
    self.observer = observer
  }

  // Runs off the caller's actor, so decoding a large screen never blocks the
  // main thread.
  @concurrent
  public func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let requestID = UUID().uuidString
    let start = ContinuousClock.now
    let (status, result) = await perform(request, requestID: requestID)
    let error: APIError? =
      switch result {
      case .success: nil
      case .failure(let error): error
      }
    let record = APIRequestRecord(
      method: request.method.rawValue,
      route: request.route,
      requestID: requestID,
      status: status,
      duration: start.duration(to: .now),
      error: error
    )
    observer?.requestFinished(record)
    return try result.get()
  }

  private func perform<Response>(
    _ request: APIRequest<Response>,
    requestID: String
  ) async -> (status: Int?, result: Result<Response, APIError>) {
    let token = await session.token
    let cacheKey = request.method == .get ? request.pathAndQuery : nil
    var cached: CachedRead?
    if let cacheKey { cached = cache.withLock { $0[cacheKey] } }
    let urlRequest: URLRequest
    do {
      urlRequest = try makeRequest(
        request,
        requestID: requestID,
        token: token,
        etag: cached?.etag
      )
    } catch {
      return (nil, .failure(error))
    }
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.send(urlRequest)
    } catch {
      return (nil, .failure(APIError(kind: Self.kind(of: error), requestID: requestID)))
    }
    do {
      let value = try await read(
        response,
        data: data,
        for: request,
        context: Context(requestID: requestID, token: token, cacheKey: cacheKey, cached: cached)
      )
      return (response.statusCode, .success(value))
    } catch {
      return (response.statusCode, .failure(error))
    }
  }

  private func makeRequest<Response>(
    _ request: APIRequest<Response>,
    requestID: String,
    token: String?,
    etag: String?
  ) throws(APIError) -> URLRequest {
    guard let url = URL(string: request.pathAndQuery, relativeTo: serverURL) else {
      throw APIError(kind: .invalidRequest, requestID: requestID)
    }
    var urlRequest = URLRequest(url: url.absoluteURL)
    urlRequest.httpMethod = request.method.rawValue
    urlRequest.httpShouldHandleCookies = false
    urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
    urlRequest.setValue(clientHeader, forHTTPHeaderField: "Screenr-Client")
    urlRequest.setValue(requestID, forHTTPHeaderField: "Screenr-Request-Id")
    if let token { urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let invitation = request.invitation {
      urlRequest.setValue(invitation, forHTTPHeaderField: "Screenr-Invitation")
    }
    if let etag { urlRequest.setValue(etag, forHTTPHeaderField: "If-None-Match") }
    switch request.body {
    case .json(let value):
      do {
        urlRequest.httpBody = try ScreenrJSON.encoder().encode(value)
      } catch {
        throw APIError(kind: .invalidRequest, requestID: requestID)
      }
      urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    case .upload(let data, let contentType):
      urlRequest.httpBody = data
      urlRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
    case nil:
      break
    }
    return urlRequest
  }

  private struct Context {
    let requestID: String
    // The session token the request sent.
    let token: String?
    let cacheKey: String?
    let cached: CachedRead?
  }

  private func read<Response>(
    _ response: HTTPURLResponse,
    data: Data,
    for request: APIRequest<Response>,
    context: Context
  ) async throws(APIError) -> Response {
    switch response.statusCode {
    case 200..<300:
      let value = try Self.decode(Response.self, from: data, requestID: context.requestID)
      if let cacheKey = context.cacheKey, let etag = response.value(forHTTPHeaderField: "ETag") {
        cache.withLock { $0[cacheKey] = CachedRead(etag: etag, value: value) }
      }
      try await apply(request.sessionChange, response: response, context: context)
      return value
    case 304:
      guard let value = context.cached?.value as? Response else {
        throw APIError(kind: .invalidResponse, requestID: context.requestID)
      }
      return value
    default:
      let error = APIError(
        status: response.statusCode,
        body: Self.errorBody(data),
        requestID: context.requestID
      )
      switch error.kind {
      case .signedOut:
        // Only a request that carried a token learns its session is gone; a
        // rejected sign-in attempt carries none.
        if let token = context.token { try await endSession(token, requestID: context.requestID) }
      case .updateRequired(let minimumBuild):
        await session.requireUpdate(minimumBuild: minimumBuild)
      default:
        break
      }
      throw error
    }
  }

  private func apply(
    _ change: SessionChange,
    response: HTTPURLResponse,
    context: Context
  ) async throws(APIError) {
    switch change {
    case .none:
      break
    case .signIn:
      guard let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty
      else { throw APIError(kind: .invalidResponse, requestID: context.requestID) }
      do {
        try await session.signIn(token: token)
      } catch {
        throw APIError(kind: .keychain, requestID: context.requestID)
      }
      cache.withLock { $0.removeAll() }
    case .signOut:
      if let token = context.token { try await endSession(token, requestID: context.requestID) }
    }
  }

  // Removes the ended session's token and the screens it read.
  private func endSession(_ token: String, requestID: String) async throws(APIError) {
    cache.withLock { $0.removeAll() }
    do {
      try await session.end(token: token)
    } catch {
      throw APIError(kind: .keychain, requestID: requestID)
    }
  }

  private static func decode<Value: Decodable>(
    _ type: Value.Type,
    from data: Data,
    requestID: String
  ) throws(APIError) -> Value {
    do {
      return try ScreenrJSON.decoder().decode(type, from: data)
    } catch {
      throw APIError(kind: .invalidResponse, requestID: requestID)
    }
  }

  // An error response's explanation. Proxy pages and empty bodies have none.
  private static func errorBody(_ data: Data) -> ErrorBody? {
    do {
      return try ScreenrJSON.decoder().decode(ErrorBody.self, from: data)
    } catch {
      return nil
    }
  }

  private static func kind(of error: any Error) -> APIError.Kind {
    if error is CancellationError { return .cancelled }
    guard let error = error as? URLError else { return .offline }
    switch error.code {
    case .timedOut: return .timedOut
    case .cancelled: return .cancelled
    default: return .offline
    }
  }
}
