import Foundation
import Sentry
import Testing

@testable import ScreenrKit

struct SentryPrivacyTests {
  @Test func keepsOnlyTheIDOfTheUser() {
    let event = Event(level: .error)
    let user = User(userId: "user-7f3a")
    user.email = "alice@example.com"
    user.username = "alice"
    user.name = "Alice Smith"
    user.ipAddress = "203.0.113.7"
    user.geo = Geo()
    user.data = ["nickname": "Al"]
    event.user = user

    let scrubbed = SentryPrivacy.scrub(event)

    #expect(scrubbed.user?.userId == "user-7f3a")
    #expect(scrubbed.user?.email == nil)
    #expect(scrubbed.user?.username == nil)
    #expect(scrubbed.user?.name == nil)
    #expect(scrubbed.user?.ipAddress == nil)
    #expect(scrubbed.user?.geo == nil)
    #expect(scrubbed.user?.data == nil)
  }

  @Test func dropsAUserWithoutAnID() {
    let event = Event(level: .error)
    let user = User()
    user.email = "alice@example.com"
    event.user = user

    #expect(SentryPrivacy.scrub(event).user == nil)
  }

  @Test func reducesTheRequestToItsRoute() {
    let event = Event(level: .error)
    let request = SentryRequest()
    request.url = "https://screenr.club/people/alice?tab=top"
    request.queryString = "tab=top"
    request.fragment = "replies"
    request.cookies = "session=secret"
    request.headers = ["Authorization": "Bearer secret"]
    request.method = "GET"
    event.request = request

    let scrubbed = SentryPrivacy.scrub(event).request

    #expect(scrubbed?.url == "https://screenr.club/people/:username")
    #expect(scrubbed?.method == "GET")
    #expect(scrubbed?.queryString == nil)
    #expect(scrubbed?.fragment == nil)
    #expect(scrubbed?.cookies == nil)
    #expect(scrubbed?.headers == nil)
  }

  @Test func removesTheDeviceNameAndServerName() {
    let event = Event(level: .error)
    event.serverName = "alices-mac"
    event.context = ["device": ["name": "Alice's iPhone", "model": "iPhone18,1"]]

    let scrubbed = SentryPrivacy.scrub(event)

    #expect(scrubbed.serverName == nil)
    #expect(scrubbed.context?["device"] as? [String: String] == ["model": "iPhone18,1"])
  }

  @Test func describesACapturedErrorByItsTypeAndCodeAlone() {
    let event = Event(level: .error)
    let exception = Exception(value: "noResults(query: \"dune\") (Code: 2)", type: "Search.Failure")
    let mechanism = Mechanism(type: "NSError")
    mechanism.desc = "noResults(query: \"dune\")"
    mechanism.data = ["NSErrorFailingURLStringKey": "https://screenr.club/search?q=dune"]
    mechanism.meta = MechanismContext()
    mechanism.meta?.error = SentryNSError(domain: "Search.Failure", code: 2)
    exception.mechanism = mechanism
    event.exceptions = [exception]
    event.context = [
      "user info": ["NSErrorFailingURLStringKey": "https://screenr.club/search?q=dune"]
    ]
    event.message = SentryMessage(formatted: "Search for dune failed")

    let scrubbed = SentryPrivacy.scrub(event)

    let scrubbedException = scrubbed.exceptions?.first
    #expect(scrubbedException?.type == "Search.Failure")
    #expect(scrubbedException?.value == "Code: 2")
    #expect(scrubbedException?.mechanism?.desc == nil)
    #expect(scrubbedException?.mechanism?.data == nil)
    #expect(scrubbedException?.mechanism?.meta?.error?.code == 2)
    #expect(scrubbed.context?["user info"] == nil)
    #expect(scrubbed.message == nil)
  }

  @Test func keepsACrashReasonWithItsURLsReduced() {
    let event = Event(level: .fatal)
    let exception = Exception(
      value: "Could not load https://screenr.club/people/alice?tab=top",
      type: "NSInternalInconsistencyException"
    )
    exception.mechanism = Mechanism(type: "nsexception")
    event.exceptions = [exception]

    let scrubbed = SentryPrivacy.scrub(event)

    #expect(
      scrubbed.exceptions?.first?.value == "Could not load https://screenr.club/people/:username"
    )
  }

  @Test func keepsBreadcrumbDataThatHoldsNoContent() {
    let breadcrumb = makeBreadcrumb(
      "touch",
      [
        "view": "<UIButton: 0x1; frame = (0 0; 10 10)> Alice Smith",
        "title": "Alice Smith",
        "accessibilityIdentifier": "friend-alice",
        "tag": 3,
        "screen": "ProfileViewController",
        "state": "foreground",
      ]
    )
    breadcrumb.message = "buttonPressed:"

    let scrubbed = SentryPrivacy.scrub(breadcrumb)

    #expect(scrubbed?.message == "buttonPressed:")
    #expect(Set(scrubbed?.data?.keys.map { $0 } ?? []) == ["screen", "state"])
  }

  @Test func reducesBreadcrumbURLsToRoutes() {
    let breadcrumb = makeBreadcrumb(
      "http",
      [
        "url": "https://screenr.club/search?q=dune",
        "to": "/people/alice",
        "from": "/titles/movie/438631?item=9",
        "http.query": "q=dune",
        "http.fragment": "top",
        "method": "GET",
        "status_code": 200,
        "request_id": "3f2a9c",
      ]
    )
    breadcrumb.message = "Loaded https://screenr.club/people/alice?tab=top"

    let scrubbed = SentryPrivacy.scrub(breadcrumb)

    #expect(scrubbed?.message == "Loaded https://screenr.club/people/:username")
    let data = scrubbed?.data ?? [:]
    #expect(data["url"] as? String == "https://screenr.club/search")
    #expect(data["to"] as? String == "/people/:username")
    #expect(data["from"] as? String == "/titles/:kind/:id")
    #expect(data["method"] as? String == "GET")
    #expect(data["status_code"] as? Int == 200)
    #expect(data["request_id"] as? String == "3f2a9c")
    #expect(data["http.query"] == nil)
    #expect(data["http.fragment"] == nil)
  }

  @Test func removesUserNamesFromLogs() {
    let log = SentryLog(
      level: .warn,
      body: "Request failed",
      attributes: [
        "user.id": SentryLog.Attribute(string: "user-7f3a"),
        "user.name": SentryLog.Attribute(string: "alice"),
        "user.email": SentryLog.Attribute(string: "alice@example.com"),
        "status": SentryLog.Attribute(integer: 503),
      ]
    )

    let scrubbed = SentryPrivacy.scrub(log)

    #expect(Set(scrubbed?.attributes.keys.map { $0 } ?? []) == ["user.id", "status"])
  }

  @Test func reducesSpanURLsToRoutes() async throws {
    let capture = SentryEnvelopeCapture()
    defer { capture.close() }
    _ = Telemetry(
      variant: .release,
      router: LogRouter(),
      sessionRoll: 0,
      start: capture.start
    )

    capture.recordTransaction(name: "Load") { transaction in
      let child = transaction.startChild(
        operation: "http.client",
        description: "GET https://screenr.club/people/alice?tab=top"
      )
      child.setData(value: "https://screenr.club/people/alice?tab=top", key: "url")
      child.setData(value: "tab=top", key: "http.query")
      child.setData(value: "replies", key: "http.fragment")
      child.finish()
      transaction.finish()
    }

    let transaction = try #require(try await capture.items(ofType: "transaction", count: 1).only)
    let spans = try #require(try transaction.json["spans"] as? [[String: Any]])
    let span = try #require(spans.only)
    #expect(span["description"] as? String == "GET https://screenr.club/people/:username")
    let data = span["data"] as? [String: Any] ?? [:]
    #expect(data["url"] as? String == "https://screenr.club/people/:username")
    #expect(data["http.query"] == nil)
    #expect(data["http.fragment"] == nil)
    #expect(!transaction.text.contains("alice"))
  }
}
