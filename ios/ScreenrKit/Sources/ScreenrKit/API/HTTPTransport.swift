import Foundation

// Sends one HTTP request. The client uses URLSession on the network; tests
// and the fixture API answer requests in process.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
  private let session: URLSession

  public init(configuration: URLSessionConfiguration = URLSessionTransport.configuration()) {
    session = URLSession(configuration: configuration)
  }

  // An ephemeral configuration that neither sends nor stores cookies, since
  // Better Auth checks the Origin of any POST that carries one. The client
  // keeps its own screen cache, so URLSession caches nothing. A request stops
  // waiting after 15 seconds, as on the web.
  public static func configuration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 15
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    return configuration
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw URLError(.badServerResponse)
    }
    return (data, response)
  }
}
