import Foundation
import Synchronization

// Which fixtures answer, for a UI test or a Dev launch without a server.
public struct FixtureScenario: Hashable, Sendable {
  public enum Session: String, Hashable, Sendable {
    case signedIn
    case signedOut
  }

  // Whether the viewer has set up a profile.
  public enum Profile: String, Hashable, Sendable {
    case complete
    // Like a new member on the server, the viewer gets
    // `errors/incomplete-profile` from every action but setup, its details,
    // photo changes, and account deletion, until a setup request succeeds.
    case pending
  }

  // The member whose fixtures answer first, such as `alice`, the usual
  // viewer, `nora`, who has no friends or activity, or `pat`, who has not
  // finished setup.
  public var viewer: String
  // The session the app starts with. Signing in through the fixture API
  // always succeeds.
  public var session: Session
  public var profile: Profile
  // Fixtures that answer their action, and for `screen` their path, before
  // any other, such as `screen/feed/empty` or `actions/setup/username-taken`.
  public var overrides: [String]
  // A fixture that answers every `/api/screenr` request, such as
  // `errors/update-required`.
  public var failure: String?
  // A file that gets one line per `/api/screenr` request, such as
  // `GET /api/screenr/screen?path=%2F`, so UI tests can see when the app reads
  // and what it writes.
  public var requestLog: URL?

  public init(
    viewer: String = "alice",
    session: Session = .signedIn,
    profile: Profile = .complete,
    overrides: [String] = [],
    failure: String? = nil,
    requestLog: URL? = nil
  ) {
    self.viewer = viewer
    self.session = session
    self.profile = profile
    self.overrides = overrides
    self.failure = failure
    self.requestLog = requestLog
  }
}

// Appends each request the fixture API answers to the scenario's log file,
// such as `GET /api/screenr/screen?path=%2F`, with ` visit` after the app's
// visit and a write's JSON body after the write.
final class FixtureRequestLog: Sendable {
  private let file: URL
  private let lock = Mutex(())

  // Starts an empty log.
  init(file: URL) throws {
    guard FileManager.default.createFile(atPath: file.path(), contents: Data()) else {
      throw FixtureError("Cannot create the request log \(file.path())")
    }
    self.file = file
  }

  func record(_ request: URLRequest, path: String, body: JSONValue?) throws {
    var line = (request.httpMethod ?? "GET") + " " + path
    if let query = request.url?.query(percentEncoded: true) { line += "?" + query }
    if request.value(forHTTPHeaderField: "Screenr-Visit") != nil { line += " visit" }
    // A JSON body follows on one line, with sorted keys, such as
    // `POST /api/screenr/read-notifications {"through":"23"}`, and an
    // upload's type and size, such as `POST /api/screenr/photo image/jpeg
    // 41250 bytes`.
    if let body {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      line += " " + String(decoding: try encoder.encode(body), as: UTF8.self)
    } else if let upload = request.httpBody,
      let type = request.value(forHTTPHeaderField: "Content-Type")
    {
      line += " \(type) \(upload.count) bytes"
    }
    // A handle that fails before closing closes when it is released.
    try lock.withLock { _ in
      let handle = try FileHandle(forWritingTo: file)
      try handle.seekToEnd()
      try handle.write(contentsOf: Data((line + "\n").utf8))
      try handle.close()
    }
  }
}

// Whether a viewer who started without a profile has set one up.
final class FixtureSetup: Sendable {
  private let done = Mutex(false)

  var isDone: Bool { done.withLock { $0 } }

  func complete() {
    done.withLock { $0 = true }
  }
}

// An in-process Screenr server that answers from the checked-in fixtures, so
// the app runs its real client against recorded responses.
//
// - `/api/screenr` requests without a bearer token get `errors/signed-out`.
// - A viewer whose profile is pending gets `errors/incomplete-profile` from
//   member actions until a setup request succeeds.
// - Otherwise the fixture with the same action and the same query or body
//   answers, preferring the scenario's viewer. A `screen` path with other
//   query parameters falls back to its path alone. Other GETs and POSTs fall
//   back to a successful fixture for the action, `default` first. Fixtures
//   under `errors/`, and those whose request sent extra headers, answer only
//   as overrides or the failure.
// - A fixture's ETag in `If-None-Match` gets 304, as on the server.
// - Better Auth's routes succeed: requesting a code, signing in, which returns
//   `FixtureTransport.token` in `set-auth-token`, linking a sign-in method,
//   signing out, and checking an invitation, which is available. An `auth/`
//   override answers its route instead, such as
//   `auth/email-otp/send-verification-otp/rate-limited` or
//   `auth/invitation/unavailable`. Apple and Google sign-in and linking accept
//   only `FixtureIdentity`'s stub credentials.
// - Google's token endpoint redeems `FixtureWebAuthenticator`'s stub codes.
public struct FixtureTransport: HTTPTransport {
  public static let token = "fixture-session"

  // The actions a member without a profile can use, as on the server.
  private static let beforeProfile: Set = [
    "setup", "setup-details", "photo", "remove-photo", "google-photo", "delete-account",
  ]

  private let fixtures: [Fixture]
  private let scenario: FixtureScenario
  private let log: FixtureRequestLog?
  // Set while the viewer's profile is pending.
  private let setup: FixtureSetup?

  public init(directory: URL, scenario: FixtureScenario = FixtureScenario()) throws {
    fixtures = try Fixture.all(in: directory)
    self.scenario = scenario
    if let file = scenario.requestLog {
      log = try FixtureRequestLog(file: file)
    } else {
      log = nil
    }
    setup = scenario.profile == .pending ? FixtureSetup() : nil
    var named = scenario.overrides
    if let failure = scenario.failure { named.append(failure) }
    let names = Set(fixtures.map(\.name))
    for name in named where !names.contains(name) {
      throw FixtureError("There is no fixture named \(name)")
    }
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    guard let url = request.url else { throw URLError(.badURL) }
    if url.host() == GoogleSignIn.tokenHost { return try googleToken(request, url: url) }
    let path = url.path()
    if path.hasPrefix("/api/auth/") {
      return try auth(String(path.dropFirst("/api/auth/".count)), request: request, url: url)
    }
    guard path.hasPrefix("/api/screenr/") else {
      return try reply(url: url, status: 404, body: ["error": "Not found."])
    }
    try log?.record(request, path: path, body: Incoming.json(request))
    let requestID = request.value(forHTTPHeaderField: "Screenr-Request-Id")
    if let failure = fixture(named: scenario.failure) {
      return try reply(url: url, fixture: failure, requestID: requestID)
    }
    let bearer = request.value(forHTTPHeaderField: "Authorization")
    guard let bearer, bearer.hasPrefix("Bearer ") else {
      guard let signedOut = fixture(named: "errors/signed-out") else {
        return try reply(url: url, status: 401, body: ["error": "Sign in to continue."])
      }
      return try reply(url: url, fixture: signedOut, requestID: requestID)
    }
    let action = String(path.dropFirst("/api/screenr/".count))
    if let setup, !setup.isDone, !Self.beforeProfile.contains(action),
      let incomplete = fixture(named: "errors/incomplete-profile")
    {
      return try reply(url: url, fixture: incomplete, requestID: requestID)
    }
    let incoming = Incoming(request: request, action: action)
    guard let fixture = match(incoming) else {
      let error: JSONValue =
        action == "screen" ? ["error": "Page not found."] : ["error": "Action not found."]
      return try reply(url: url, status: 404, body: error, requestID: requestID)
    }
    if let etag = fixture.response.etag,
      request.value(forHTTPHeaderField: "If-None-Match") == etag
    {
      return try reply(url: url, status: 304, etag: etag, requestID: requestID)
    }
    if action == "setup", (200..<300).contains(fixture.response.status) { setup?.complete() }
    return try reply(url: url, fixture: fixture, requestID: requestID)
  }

  private struct Incoming {
    let method: HTTPMethod?
    let action: String
    let query: [String: String]
    let body: JSONValue?

    init(request: URLRequest, action: String) {
      method = HTTPMethod(rawValue: request.httpMethod ?? "GET")
      self.action = action
      var query: [String: String] = [:]
      if let url = request.url,
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
      {
        for item in items { query[item.name] = item.value ?? "" }
      }
      self.query = query
      body = Self.json(request)
    }

    static func json(_ request: URLRequest) -> JSONValue? {
      guard let data = request.httpBody,
        request.value(forHTTPHeaderField: "Content-Type") == "application/json"
      else { return nil }
      do {
        return try JSONDecoder().decode(JSONValue.self, from: data)
      } catch {
        return nil
      }
    }
  }

  // How closely a fixture's request matches, best first.
  private enum Closeness: Int {
    case exact
    case samePath
    case sameAction
  }

  private func match(_ incoming: Incoming) -> Fixture? {
    let ranked = fixtures.compactMap { fixture -> (Fixture, [Int])? in
      let overridden = scenario.overrides.contains(fixture.name)
      guard fixture.request.method == incoming.method,
        fixture.request.action == incoming.action,
        fixture.response.status != 304,
        overridden || Self.answersAnyRequest(fixture),
        let closeness = closeness(of: fixture, to: incoming),
        incoming.action != "screen" || closeness != .sameAction
      else { return nil }
      let succeeded = (200..<300).contains(fixture.response.status)
      return (
        fixture,
        [
          overridden ? 0 : 1,
          closeness.rawValue,
          closeness == .exact || succeeded ? 0 : 1,
          fixture.viewer == scenario.viewer ? 0 : 1,
          fixture.name.hasSuffix("/default") ? 0 : 1,
        ]
      )
    }
    let best = ranked.min { left, right in
      left.1 == right.1 ? left.0.name < right.0.name : left.1.lexicographicallyPrecedes(right.1)
    }
    guard let (fixture, _) = best else { return nil }
    return fixture
  }

  private func closeness(of fixture: Fixture, to incoming: Incoming) -> Closeness? {
    switch incoming.method {
    case .get:
      let query = fixture.request.query ?? [:]
      if query == incoming.query { return .exact }
      if incoming.action == "screen" {
        return Self.pathname(query["path"]) == Self.pathname(incoming.query["path"])
          ? .samePath : .sameAction
      }
      return .sameAction
    case .post:
      return fixture.request.body == incoming.body ? .exact : .sameAction
    case nil:
      return nil
    }
  }

  // Shared errors, such as a missing profile, and requests with extra headers,
  // such as an old build's, answer only as overrides or the scenario's failure.
  private static func answersAnyRequest(_ fixture: Fixture) -> Bool {
    !fixture.name.hasPrefix("errors/") && !fixture.name.hasPrefix("auth/")
      && fixture.request.headers == nil
  }

  private static func pathname(_ path: String?) -> Substring? {
    guard let path else { return nil }
    return path.prefix { $0 != "?" }
  }

  private func fixture(named name: String?) -> Fixture? {
    guard let name else { return nil }
    return fixtures.first { $0.name == name }
  }

  private func auth(
    _ route: String,
    request: URLRequest,
    url: URL
  ) throws -> (Data, HTTPURLResponse) {
    let override = fixtures.first { fixture in
      fixture.name.hasPrefix("auth/") && fixture.request.action == route
        && scenario.overrides.contains(fixture.name)
    }
    if let override { return try reply(url: url, fixture: override, requestID: nil) }
    switch route {
    case "email-otp/send-verification-otp", "sign-out":
      return try reply(url: url, status: 200, body: ["success": true])
    case "invitation":
      return try reply(url: url, status: 200, body: ["available": true])
    case "sign-in/social" where !FixtureIdentity.accepts(Incoming.json(request)):
      return try reply(
        url: url,
        status: 401,
        body: ["code": "INVALID_TOKEN", "message": "Invalid token"]
      )
    case "sign-in/email-otp", "sign-in/social":
      return try reply(
        url: url,
        status: 200,
        body: [
          "token": .string(Self.token), "user": ["id": .string("user-\(scenario.viewer)")],
        ],
        headers: ["set-auth-token": Self.token]
      )
    case "link-social" where request.value(forHTTPHeaderField: "Authorization") == nil:
      return try reply(
        url: url,
        status: 401,
        body: ["code": "UNAUTHORIZED", "message": "Unauthorized"]
      )
    case "link-social" where !FixtureIdentity.accepts(Incoming.json(request)):
      return try reply(
        url: url,
        status: 401,
        body: ["code": "INVALID_TOKEN", "message": "Invalid token"]
      )
    case "link-social":
      return try reply(url: url, status: 200, body: ["url": "", "status": true, "redirect": false])
    default:
      return try reply(url: url, status: 404, body: ["message": "Not found"])
    }
  }

  private func googleToken(_ request: URLRequest, url: URL) throws -> (Data, HTTPURLResponse) {
    let form = FormEncoding.decode(String(decoding: request.httpBody ?? Data(), as: UTF8.self))
    guard request.httpMethod == "POST", url.path() == "/token",
      let idToken = FixtureIdentity.redeem(form)
    else {
      return try reply(
        url: url,
        status: 400,
        body: ["error": "invalid_grant", "error_description": "Bad Request"]
      )
    }
    return try reply(
      url: url,
      status: 200,
      body: [
        "access_token": "fixture-google-access", "expires_in": 3599,
        "id_token": .string(idToken), "scope": .string(GoogleSignIn.scopes),
        "token_type": "Bearer",
      ]
    )
  }

  private func reply(
    url: URL,
    fixture: Fixture,
    requestID: String?
  ) throws -> (Data, HTTPURLResponse) {
    try reply(
      url: url,
      status: fixture.response.status,
      body: fixture.response.body,
      etag: fixture.response.etag,
      requestID: requestID
    )
  }

  private func reply(
    url: URL,
    status: Int,
    body: JSONValue? = nil,
    etag: String? = nil,
    requestID: String? = nil,
    headers: [String: String] = [:]
  ) throws -> (Data, HTTPURLResponse) {
    var fields = headers
    fields["ETag"] = etag
    fields["Screenr-Request-Id"] = requestID
    var data = Data()
    if let body, body != .null {
      data = try JSONEncoder().encode(body)
      fields["Content-Type"] = "application/json"
    }
    guard
      let response = HTTPURLResponse(
        url: url,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: fields
      )
    else { throw URLError(.cannotParseResponse) }
    return (data, response)
  }
}
