import Foundation

// One Screenr API call and the type of its response. Build requests with the
// static functions in MemberRequests.swift and AuthRequests.swift, such as
// `.screen(path: "/")`, and send them with `ScreenrAPI.send(_:)`.
public struct APIRequest<Response: Decodable & Sendable>: Sendable {
  public let method: HTTPMethod
  public let endpoint: APIEndpoint
  public let query: [String: String]
  public let body: RequestBody?
  // An invitation token from a `/join/<token>` link, sent as
  // `Screenr-Invitation` while a new member signs up.
  public let invitation: String?
  public let sessionChange: SessionChange
  public let visit: VisitSignal
  // The endpoint without member content, such as search text or usernames,
  // for logs: `/api/screenr/screen?path=/people/:username`.
  public let route: String

  public init(
    method: HTTPMethod,
    endpoint: APIEndpoint,
    query: [String: String] = [:],
    body: RequestBody? = nil,
    invitation: String? = nil,
    sessionChange: SessionChange = .none,
    visit: VisitSignal = .never,
    route: String? = nil
  ) {
    self.method = method
    self.endpoint = endpoint
    self.query = query
    self.body = body
    self.invitation = invitation
    self.sessionChange = sessionChange
    self.visit = visit
    self.route = route ?? endpoint.path
  }

  // The path and query, with every reserved character in a query value
  // percent-encoded, so a value such as `/?item=1&reply=2` arrives intact.
  public var pathAndQuery: String {
    guard !query.isEmpty else { return endpoint.path }
    let pairs = query.sorted { $0.key < $1.key }
      .map { key, value in
        "\(QueryEncoding.encode(key))=\(QueryEncoding.encode(value))"
      }
    return endpoint.path + "?" + pairs.joined(separator: "&")
  }
}

public enum HTTPMethod: String, Codable, Hashable, Sendable {
  case get = "GET"
  case post = "POST"
}

public enum APIEndpoint: Hashable, Sendable {
  // `/api/screenr/<action>`.
  case action(String)
  // `/api/auth/<path>`, Better Auth's routes.
  case auth(String)
  // `/api/photos/<user ID>/<version>`, a profile photo's JPEG, which the
  // client returns as its bytes.
  case photo(userId: String, version: String)

  public var path: String {
    switch self {
    case .action(let name): "/api/screenr/\(name)"
    case .auth(let path): "/api/auth/\(path)"
    case .photo(let userId, let version):
      "/api/photos/\(PathEncoding.component(userId))/\(PathEncoding.component(version))"
    }
  }
}

public enum RequestBody: Hashable, Sendable {
  case json(JSONValue)
  // A file sent as the raw body, such as a JPEG for `photo`.
  case upload(Data, contentType: String)
}

// Whether a request can carry the app's visit for usage telemetry, as
// `VisitTracker` describes.
public enum VisitSignal: Hashable, Sendable {
  case never
  // Carries `Screenr-Visit: 1` when a visit is due.
  case whenDue
}

// What a successful response does to the stored session.
public enum SessionChange: Hashable, Sendable {
  case none
  // Stores the token from the `set-auth-token` header.
  case signIn
  // Removes the token the request sent.
  case signOut
}

private enum QueryEncoding {
  static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  )

  // Percent-encoding fails only for invalid UTF-16, which a String cannot hold.
  static func encode(_ text: String) -> String {
    text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
  }
}
