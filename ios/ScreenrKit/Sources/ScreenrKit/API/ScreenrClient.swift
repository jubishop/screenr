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
// - `Screenr-Visit: 1` on the screen read that `visits` marks as a visit.
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
  private let visits: VisitTracker?
  // Keyed by path and query, such as `/api/screenr/screen?path=%2F`.
  private let cache = Mutex<[String: CachedRead]>([:])

  // `clientHeader` is `AppConfiguration.clientHeader`. Without `visits`, as
  // in an extension, no read is a visit.
  public init(
    serverURL: URL,
    clientHeader: String,
    session: SessionStore,
    transport: any HTTPTransport = URLSessionTransport(),
    observer: (any APIRequestObserver)? = nil,
    visits: VisitTracker? = nil
  ) {
    self.serverURL = serverURL
    self.clientHeader = clientHeader
    self.session = session
    self.transport = transport
    self.observer = observer
    self.visits = visits
  }

  // Runs off the caller's actor, so decoding a large screen never blocks the
  // main thread.
  @concurrent
  public func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let requestID = UUID().uuidString
    let start = ContinuousClock.now
    let visit: VisitTracker.Visit? =
      switch request.visit {
      case .never: nil
      case .whenDue: visits?.startRead()
      }
    let (status, result) = await perform(request, requestID: requestID, visit: visit)
    if let visit { visits?.finish(visit, status: status) }
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
    requestID: String,
    visit: VisitTracker.Visit?
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
        etag: cached?.etag,
        visit: visit
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
    etag: String?,
    visit: VisitTracker.Visit?
  ) throws(APIError) -> URLRequest {
    guard let url = URL(string: request.pathAndQuery, relativeTo: serverURL) else {
      throw APIError(kind: .invalidRequest, requestID: requestID)
    }
    var urlRequest = URLRequest(url: url.absoluteURL)
    urlRequest.httpMethod = request.method.rawValue
    urlRequest.httpShouldHandleCookies = false
    let accept = if case .photo = request.endpoint { "image/jpeg" } else { "application/json" }
    urlRequest.setValue(accept, forHTTPHeaderField: "Accept")
    urlRequest.setValue(clientHeader, forHTTPHeaderField: "Screenr-Client")
    urlRequest.setValue(requestID, forHTTPHeaderField: "Screenr-Request-Id")
    if let token { urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let invitation = request.invitation {
      urlRequest.setValue(invitation, forHTTPHeaderField: "Screenr-Invitation")
    }
    if let etag { urlRequest.setValue(etag, forHTTPHeaderField: "If-None-Match") }
    if visit != nil { urlRequest.setValue("1", forHTTPHeaderField: "Screenr-Visit") }
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
      let value = try Self.decode(request, from: data, requestID: context.requestID)
      if let cacheKey = context.cacheKey, let etag = response.value(forHTTPHeaderField: "ETag") {
        cache.withLock { $0[cacheKey] = CachedRead(etag: etag, value: value) }
      }
      try await apply(request.sessionChange, response: response, data: data, context: context)
      return value
    case 304:
      guard let value = context.cached?.value as? Response else {
        throw APIError(kind: .invalidResponse, requestID: context.requestID)
      }
      return value
    default:
      let body = Self.errorBody(data)
      var error = APIError(status: response.statusCode, body: body, requestID: context.requestID)
      if error.kind == .signedOut, request.unauthorized == .rejectsCredential,
        error.code != "UNAUTHORIZED"
      {
        error = APIError(
          kind: .rejected(status: response.statusCode),
          message: error.message,
          code: error.code,
          requestID: context.requestID
        )
      }
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
    data: Data,
    context: Context
  ) async throws(APIError) {
    switch change {
    case .none:
      break
    case .signIn:
      try await store(Self.sessionToken(response, requestID: context.requestID), context: context)
    case .confirmSignIn(let userId):
      let token = try Self.sessionToken(response, requestID: context.requestID)
      let user: String
      do {
        user = try ScreenrJSON.decoder().decode(SignedInUser.self, from: data).user.id
      } catch {
        await discard(token)
        throw APIError(kind: .invalidResponse, requestID: context.requestID)
      }
      guard user == userId else {
        await discard(token)
        throw APIError(kind: .otherAccount, requestID: context.requestID)
      }
      try await store(token, context: context)
    case .signOut:
      if let token = context.token { try await endSession(token, requestID: context.requestID) }
    case .accountDeleted:
      if let token = context.token {
        try await endSession(token, ending: .accountDeleted, requestID: context.requestID)
      }
    }
  }

  // Better Auth's sign-in response names the person it signed in.
  private struct SignedInUser: Decodable {
    struct User: Decodable {
      let id: String
    }

    let user: User
  }

  private static func sessionToken(
    _ response: HTTPURLResponse,
    requestID: String
  ) throws(APIError) -> String {
    guard let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty
    else { throw APIError(kind: .invalidResponse, requestID: requestID) }
    return token
  }

  // Keeps a new session's token in place of any earlier one, and forgets the
  // screens the earlier one read.
  private func store(_ token: String, context: Context) async throws(APIError) {
    do {
      try await session.signIn(token: token)
    } catch {
      throw APIError(kind: .keychain, requestID: context.requestID)
    }
    cache.withLock { $0.removeAll() }
  }

  // Signs out a new session that this device will not keep, such as another
  // account's, so it does not stay open on the server until it expires.
  private func discard(_ token: String) async {
    let requestID = UUID().uuidString
    do {
      let request = try makeRequest(
        .signOut,
        requestID: requestID,
        token: token,
        etag: nil,
        visit: nil
      )
      let (_, response) = try await transport.send(request)
      guard (200..<300).contains(response.statusCode) else {
        Log.session.warning(
          "Could not end a session the app did not keep",
          .int("status", response.statusCode),
          .identifier("request_id", requestID)
        )
        return
      }
    } catch {
      Log.session.warning(
        "Could not end a session the app did not keep",
        .error(error),
        .identifier("request_id", requestID)
      )
    }
  }

  // Removes the ended session's token and the screens it read.
  private func endSession(
    _ token: String,
    ending: SessionStore.Ending = .signedOut,
    requestID: String
  ) async throws(APIError) {
    cache.withLock { $0.removeAll() }
    do {
      try await session.end(token: token, ending: ending)
    } catch {
      throw APIError(kind: .keychain, requestID: requestID)
    }
  }

  // A photo's response is its JPEG; every other response is JSON.
  private static func decode<Response>(
    _ request: APIRequest<Response>,
    from data: Data,
    requestID: String
  ) throws(APIError) -> Response {
    if case .photo = request.endpoint {
      guard let bytes = data as? Response else {
        throw APIError(kind: .invalidResponse, requestID: requestID)
      }
      return bytes
    }
    do {
      return try ScreenrJSON.decoder().decode(Response.self, from: data)
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
