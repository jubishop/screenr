import Foundation
import Synchronization

// Which fixtures answer, for a UI test or a Dev launch without a server.
public struct FixtureScenario: Hashable, Sendable {
  public enum Session: String, Hashable, Sendable {
    case signedIn
    case signedOut
    // The app starts with a session the server no longer accepts, as after
    // it expired. Requests with its token get `errors/signed-out` until the
    // member signs in again.
    case expired
  }

  // Whether the viewer has set up a profile.
  public enum Profile: String, Hashable, Sendable {
    case complete
    // Like a new member on the server, the viewer gets
    // `errors/incomplete-profile` from every action but those that
    // `rules/before-profile` lists, such as setup, until a setup request
    // succeeds.
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
  // A file that gets one line per `/api/screenr` and `/api/auth` request,
  // such as `GET /api/screenr/screen?path=%2F`, so UI tests can see when the
  // app reads and what it writes.
  public var requestLog: URL?
  // The notification permission the app finds; see `FixturePushSystem`.
  public var push: Push
  // Fixtures that answer before any other, overrides included, once the file
  // at `updateSignal` exists, such as `screen/feed/incoming`. A UI test
  // creates the file when it wants the app's next read to bring new activity.
  public var updates: [String]
  public var updateSignal: URL?
  // While the file at `outageSignal` exists, every `/api/screenr` request
  // gets a 502 without a body, as from the proxy during a deploy. A UI test
  // creates the file to fail the app's next reads, such as a poll, and
  // removes it to end the outage.
  public var outageSignal: URL?
  // The posters the app shows; see `ImageSource.solidPosters`.
  public var posters: Posters

  public enum Posters: String, Hashable, Sendable {
    // Nothing loads, so every poster shows its title's initial.
    case placeholders
    // Every title with a poster path shows a solid gray poster.
    case solid
  }

  public init(
    viewer: String = "alice",
    session: Session = .signedIn,
    profile: Profile = .complete,
    overrides: [String] = [],
    failure: String? = nil,
    requestLog: URL? = nil,
    push: Push = .undecided,
    updates: [String] = [],
    updateSignal: URL? = nil,
    outageSignal: URL? = nil,
    posters: Posters = .placeholders
  ) {
    self.viewer = viewer
    self.session = session
    self.profile = profile
    self.overrides = overrides
    self.failure = failure
    self.requestLog = requestLog
    self.push = push
    self.updates = updates
    self.updateSignal = updateSignal
    self.outageSignal = outageSignal
    self.posters = posters
  }
}

// Appends each request the fixture API answers to the scenario's log file,
// such as `GET /api/screenr/screen?path=%2F` or `POST /api/auth/sign-out {}`,
// with ` visit` after the app's visit and a write's JSON body after the
// write.
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
    try record(line)
  }

  // A page a trailer's player asked for, such as
  // `WEB https://www.youtube.com/embed/nightCross1?autoplay=1&playsinline=1`.
  func record(webLoad url: URL) throws {
    try record("WEB " + url.absoluteString)
  }

  func record(_ line: String) throws {
    // A handle that fails before closing closes when it is released.
    try lock.withLock { _ in
      let handle = try FileHandle(forWritingTo: file)
      try handle.seekToEnd()
      try handle.write(contentsOf: Data((line + "\n").utf8))
      try handle.close()
    }
  }
}

// The fixture that last answered each screen path, by its path without a
// query.
final class FixtureAnswers: Sendable {
  private let last = Mutex<[String: String]>([:])

  func record(_ fixture: String, for path: some StringProtocol) {
    last.withLock { $0[String(path)] = fixture }
  }

  func fixture(for path: some StringProtocol) -> String? {
    last.withLock { $0[String(path)] }
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
// - While the scenario's outage signal exists, `/api/screenr` requests get
//   a 502 without a body.
// - `/api/screenr` requests without a bearer token, or with
//   `FixtureTransport.expiredToken`, get `errors/signed-out`.
// - Once the scenario's update signal exists, its updates answer first.
// - A viewer whose profile is pending gets `errors/incomplete-profile` from
//   every action but those that `rules/before-profile` lists, as the server
//   does, until a setup request succeeds.
// - Otherwise the fixture with the same action and the same query or body
//   answers, preferring the scenario's viewer. A `screen` path with other
//   query parameters falls back to its path alone. A paged feed's or
//   profile's poll, whose path names `since`, prefers the fixture that last
//   answered that path, as the server keeps the window the app read. Other
//   GETs and POSTs fall back to a successful fixture for the action,
//   `default` first. Fixtures under `errors/`, those whose request sent extra
//   headers, and paged reads, whose path names a window, answer only as
//   overrides or the failure.
// - A fixture's ETag in `If-None-Match` gets 304, as on the server. A page
//   or an action that no fixture answers gets `screen/not-found/default` or
//   `errors/unknown-action`.
// - Better Auth's routes answer from their `auth/` fixtures: an override
//   first, such as `auth/email-otp/send-verification-otp/rate-limited` or
//   `auth/invitation/unavailable`; then the route's `invalid-token` fixture
//   for Apple and Google credentials other than `FixtureIdentity`'s stubs,
//   and `link-social/signed-out` for a link without a session; and otherwise
//   the route's successful fixture, the one for the same request first, then
//   `default`. A sign-in's fixture returns `FixtureTransport.token` in
//   `set-auth-token`, and an invitation is available.
// - Google's token endpoint redeems `FixtureWebAuthenticator`'s stub codes.
public struct FixtureTransport: HTTPTransport {
  // The session token that the sign-in fixtures return.
  public static let token = "fixture-session"
  // The token of a session the fixture API no longer accepts.
  public static let expiredToken = "fixture-expired-session"

  private let fixtures: [Fixture]
  // The actions a member without a profile can use, which the server's tests
  // record from its action table in `rules/before-profile`.
  private let beforeProfile: Set<String>
  private let scenario: FixtureScenario
  private let log: FixtureRequestLog?
  private let answers = FixtureAnswers()
  // Set while the viewer's profile is pending.
  private let setup: FixtureSetup?

  // The feedback form's sender, which writes each report to the request log.
  public var feedback: any FeedbackSender {
    FixtureFeedback(log: log)
  }

  public init(directory: URL, scenario: FixtureScenario = FixtureScenario()) throws {
    fixtures = try Fixture.all(in: directory)
    beforeProfile = try FixtureRule(named: "before-profile", in: directory).actions
    self.scenario = scenario
    if let file = scenario.requestLog {
      log = try FixtureRequestLog(file: file)
    } else {
      log = nil
    }
    setup = scenario.profile == .pending ? FixtureSetup() : nil
    if !scenario.updates.isEmpty, scenario.updateSignal == nil {
      throw FixtureError("Fixture updates need a signal file")
    }
    var named = scenario.overrides + scenario.updates
    if let failure = scenario.failure { named.append(failure) }
    let names = Set(fixtures.map(\.name))
    for name in named where !names.contains(name) {
      throw FixtureError("There is no fixture named \(name)")
    }
  }

  // Logs a page that a trailer's player asked for, which loads nothing
  // against the fixture API. See `TrailerLoading.recording(_:)`.
  public func recordWebLoad(_ url: URL) throws {
    try log?.record(webLoad: url)
  }

  // Logs how the share extension ended its host's request, as
  // `SHARE completed` or `SHARE cancelled`. See `ShareEndings`.
  func recordShareEnding(_ ending: ShareEnding) throws {
    try log?.record("SHARE " + ending.rawValue)
  }

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    guard let url = request.url else { throw URLError(.badURL) }
    if url.host() == GoogleSignIn.tokenHost { return try googleToken(request, url: url) }
    let path = url.path()
    if path.hasPrefix("/api/auth/") {
      try log?.record(request, path: path, body: Incoming.json(request))
      return try auth(String(path.dropFirst("/api/auth/".count)), request: request, url: url)
    }
    guard path.hasPrefix("/api/screenr/") else {
      return try reply(url: url, status: 404, body: ["error": "Not found."])
    }
    try log?.record(request, path: path, body: Incoming.json(request))
    if inOutage() { return try reply(url: url, status: 502) }
    let requestID = request.value(forHTTPHeaderField: "Screenr-Request-Id")
    if let failure = fixture(named: scenario.failure) {
      return try reply(url: url, fixture: failure, requestID: requestID)
    }
    let bearer = request.value(forHTTPHeaderField: "Authorization")
    guard let bearer, bearer.hasPrefix("Bearer "), bearer != "Bearer " + Self.expiredToken else {
      guard let signedOut = fixture(named: "errors/signed-out") else {
        return try reply(url: url, status: 401, body: ["error": "Sign in to continue."])
      }
      return try reply(url: url, fixture: signedOut, requestID: requestID)
    }
    let action = String(path.dropFirst("/api/screenr/".count))
    if let setup, !setup.isDone, !beforeProfile.contains(action),
      let incomplete = fixture(named: "errors/incomplete-profile")
    {
      return try reply(url: url, fixture: incomplete, requestID: requestID)
    }
    let incoming = Incoming(request: request, action: action)
    guard let fixture = match(incoming) else {
      // The server's answers to a page it does not know and an action it
      // does not have.
      let missing = action == "screen" ? "screen/not-found/default" : "errors/unknown-action"
      guard let notFound = self.fixture(named: missing) else {
        throw FixtureError("There is no fixture named \(missing)")
      }
      return try reply(url: url, fixture: notFound, requestID: requestID)
    }
    if let etag = fixture.response.etag,
      request.value(forHTTPHeaderField: "If-None-Match") == etag
    {
      return try reply(url: url, status: 304, etag: etag, requestID: requestID)
    }
    if action == "setup", (200..<300).contains(fixture.response.status) { setup?.complete() }
    if action == "screen", let pathname = Self.pathname(incoming.query["path"]) {
      answers.record(fixture.name, for: pathname)
    }
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
    let updated = updated()
    // The fixture a paged poll prefers.
    var kept: String?
    if incoming.action == "screen", Self.window(of: incoming.query["path"]) == "since",
      let pathname = Self.pathname(incoming.query["path"])
    {
      kept = answers.fixture(for: pathname)
    }
    let ranked = fixtures.compactMap { fixture -> (Fixture, [Int])? in
      let update = updated && scenario.updates.contains(fixture.name)
      let overridden = update || scenario.overrides.contains(fixture.name)
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
          update ? 0 : 1,
          overridden ? 0 : 1,
          closeness.rawValue,
          fixture.name == kept ? 0 : 1,
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

  // Whether the scenario's update signal exists yet.
  private func updated() -> Bool {
    guard let signal = scenario.updateSignal else { return false }
    return FileManager.default.fileExists(atPath: signal.path())
  }

  // Whether the scenario's outage signal exists.
  private func inOutage() -> Bool {
    guard let signal = scenario.outageSignal else { return false }
    return FileManager.default.fileExists(atPath: signal.path())
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
      && fixture.request.headers == nil && window(of: fixture.request.query?["path"]) == nil
  }

  private static func pathname(_ path: String?) -> Substring? {
    guard let path else { return nil }
    return path.prefix { $0 != "?" }
  }

  // The window a paged read's member path names, `since` or `before`, or nil.
  private static func window(of path: String?) -> String? {
    guard let path, let pathname = pathname(path) else { return nil }
    let names = path.dropFirst(pathname.count + 1).split(separator: "&")
      .map { pair in
        pair.prefix { $0 != "=" }
      }
    return ["since", "before"].first { names.contains(Substring($0)) }
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
    let routeFixtures = fixtures.filter { fixture in
      fixture.name.hasPrefix("auth/") && fixture.request.action == route
    }
    if let override = routeFixtures.first(where: { scenario.overrides.contains($0.name) }) {
      return try reply(url: url, fixture: override, requestID: nil)
    }
    let incoming = Incoming(request: request, action: route)
    var error: String?
    if route == "link-social", request.value(forHTTPHeaderField: "Authorization") == nil {
      error = "signed-out"
    } else if route == "sign-in/social" || route == "link-social",
      !FixtureIdentity.accepts(incoming.body)
    {
      error = "invalid-token"
    }
    if let error {
      let name = "auth/\(route)/\(error)"
      guard let fixture = routeFixtures.first(where: { $0.name == name }) else {
        throw FixtureError("There is no fixture named \(name)")
      }
      return try reply(url: url, fixture: fixture, requestID: nil)
    }
    let rank = { (fixture: Fixture) in
      [
        closeness(of: fixture, to: incoming) == .exact ? 0 : 1,
        fixture.name.hasSuffix("/default") ? 0 : 1,
      ]
    }
    let best =
      routeFixtures
      .filter { (200..<300).contains($0.response.status) }
      .min { left, right in
        rank(left) == rank(right)
          ? left.name < right.name : rank(left).lexicographicallyPrecedes(rank(right))
      }
    guard let best else {
      return try reply(url: url, status: 404, body: ["message": "Not found"])
    }
    return try reply(url: url, fixture: best, requestID: nil)
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
      requestID: requestID,
      headers: fixture.response.headers ?? [:]
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
