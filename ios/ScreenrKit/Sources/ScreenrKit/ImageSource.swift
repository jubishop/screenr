import Foundation

// Where posters and profile photos load from, for `AsyncImage(request:)`
// through `AppServices.imageSession`. Posters are TMDB's, at the size the web
// shows. Photos are the server's `/api/photos/<user ID>/<version>`, which
// needs the session's bearer token. Against the fixture API, nothing loads, so
// every poster and avatar shows its placeholder. Views read it with
// `@Environment(\.imageSource)`.
public struct ImageSource: Sendable {
  private enum Origin: Sendable {
    case none
    case network(serverURL: URL, clientHeader: String, session: SessionStore)
  }

  private let origin: Origin

  // Loads nothing, so posters and avatars show their placeholders.
  public static let none = ImageSource(origin: .none)

  private init(origin: Origin) {
    self.origin = origin
  }

  // `clientHeader` is `AppConfiguration.clientHeader`, which the server
  // checks on photos as it does on API requests.
  public init(serverURL: URL, clientHeader: String, session: SessionStore) {
    origin = .network(serverURL: serverURL, clientHeader: clientHeader, session: session)
  }

  // A title's TMDB poster, such as `/abc.jpg`, or nil without one.
  public func poster(_ path: String?) -> URLRequest? {
    tmdb(path, size: "w342")
  }

  // A streaming service's TMDB logo, or nil without one.
  public func logo(_ path: String?) -> URLRequest? {
    tmdb(path, size: "w92")
  }

  private func tmdb(_ path: String?, size: String) -> URLRequest? {
    guard case .network = origin, let path, !path.isEmpty,
      let url = URL(string: "https://image.tmdb.org/t/p/\(size)" + path)
    else { return nil }
    return URLRequest(url: url)
  }

  // A member's profile photo version, or nil to show their initial: without a
  // photo, or while signed out.
  @MainActor
  public func photo(userId: String, version: String?) -> URLRequest? {
    guard case .network(let serverURL, let clientHeader, let session) = origin, let version,
      let token = session.token,
      let url = URL(
        string: "/api/photos/\(PathEncoding.component(userId))/\(PathEncoding.component(version))",
        relativeTo: serverURL
      )
    else { return nil }
    var request = URLRequest(url: url.absoluteURL)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue(clientHeader, forHTTPHeaderField: "Screenr-Client")
    request.httpShouldHandleCookies = false
    return request
  }
}
