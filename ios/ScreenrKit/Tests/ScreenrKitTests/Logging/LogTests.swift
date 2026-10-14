import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

struct LogTests {
  private enum Tab: String, CaseIterable {
    case friends
  }

  // Internal, so its domain names it without a private discriminator.
  enum Failure: Error {
    case rejected(username: String)
  }

  @Test func routesEachLineToTheSinksWithItsLevelCategoryAndFields() {
    let router = LogRouter()
    let sink = CapturingSink()
    router.add(sink)
    let log = Log(.api, router: router)

    log.warning(
      "Request failed",
      .int("status", 503),
      .bool("retried", true),
      .duration("duration_ms", .milliseconds(250)),
      .label("tab", Tab.friends),
      .constant("phase", "load"),
      .identifier("request_id", "3f2a9c")
    )

    let entry = sink.entries.only
    #expect(entry?.level == .warning)
    #expect(entry?.category == .api)
    #expect(entry?.message == "Request failed")
    #expect(
      entry?.fields == [
        LogField(name: "status", value: .int(503)),
        LogField(name: "retried", value: .bool(true)),
        LogField(name: "duration_ms", value: .double(250)),
        LogField(name: "tab", value: .string("friends")),
        LogField(name: "phase", value: .string("load")),
        LogField(name: "request_id", value: .string("3f2a9c")),
      ]
    )
    #expect(
      entry?.text
        == "Request failed status=503 retried=true duration_ms=250.0 tab=friends phase=load"
        + " request_id=3f2a9c"
    )
  }

  @Test func recordsEveryLevelInOrder() {
    let router = LogRouter()
    let sink = CapturingSink()
    router.add(sink)
    let log = Log(.session, router: router)

    log.debug("One")
    log.info("Two")
    log.notice("Three")
    log.warning("Four")
    log.error("Five")
    log.fault("Six")

    #expect(sink.entries.map(\.level) == [.debug, .info, .notice, .warning, .error, .fault])
    #expect(sink.entries.map(\.message) == ["One", "Two", "Three", "Four", "Five", "Six"])
  }

  @Test func describesAnErrorByItsTypeAndCodeWithoutItsContents() {
    let field = LogField.error(Failure.rejected(username: "alice"))

    #expect(field.name == "error")
    #expect(field.value == .string("ScreenrKitTests.LogTests.Failure 0"))
  }

  @Test func describesAFoundationErrorByItsDomainAndCode() throws {
    let failingURL = try #require(URL(string: "https://screenr.club/people/alice"))
    let error = URLError(.timedOut, userInfo: [NSURLErrorFailingURLErrorKey: failingURL])

    #expect(LogField.error(error).value == .string("NSURLErrorDomain -1001"))
  }

  @Test func namesTheRouteOfARequest() throws {
    let url = try #require(URL(string: "https://screenr.club/people/alice?tab=top"))

    #expect(
      LogField.route(RoutePattern(url: url))
        == LogField(name: "route", value: .string("https://screenr.club/people/:username"))
    )
  }
}

final class CapturingSink: LogSink {
  private let recorded = Mutex<[LogEntry]>([])

  var entries: [LogEntry] { recorded.withLock { $0 } }

  func record(_ entry: LogEntry) {
    recorded.withLock { $0.append(entry) }
  }
}

extension Array {
  var only: Element? { count == 1 ? first : nil }
}
