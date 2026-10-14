import Foundation
import Testing

@testable import ScreenrKit

struct LogFileTests {
  private let directory = TemporaryDirectory()
  private let launch = UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF") ?? UUID()

  @Test func writesEachEntryAsOneJSONLine() async throws {
    defer { directory.remove() }
    let file = LogFile(directory: directory.url, name: "app", launchID: launch)
    let log = Log(.api, router: LogRouter(sinks: [file]))

    log.warning("Request failed", .int("status", 503), .identifier("request_id", "3f2a9c"))
    log.info("Signed in")
    await file.flush()

    let records = try Self.records(in: file.currentURL)
    #expect(records.count == 2)
    let first = try #require(records.first)
    #expect(
      Set(first.keys) == ["time", "level", "category", "message", "launch", "fields"]
    )
    #expect(first["level"] as? String == "warning")
    #expect(first["category"] as? String == "api")
    #expect(first["message"] as? String == "Request failed")
    #expect(first["launch"] as? String == launch.uuidString)
    let fields = try #require(first["fields"] as? [String: Any])
    #expect(fields["status"] as? Int == 503)
    #expect(fields["request_id"] as? String == "3f2a9c")
    let time = try #require(first["time"] as? String)
    let written = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(time)
    #expect(abs(written.timeIntervalSinceNow) < 60)
    #expect(records.last?["message"] as? String == "Signed in")
  }

  @Test func leavesDebugLinesToTheUnifiedLog() async throws {
    defer { directory.remove() }
    let file = LogFile(directory: directory.url, name: "app", launchID: launch)
    let log = Log(.app, router: LogRouter(sinks: [file]))

    log.debug("Detail")
    log.info("Launched")
    await file.flush()

    #expect(try Self.records(in: file.currentURL).map { $0["message"] as? String } == ["Launched"])
  }

  @Test func rotatesIntoOnePreviousFileWhenTheCurrentOneFills() async throws {
    defer { directory.remove() }
    let file = LogFile(
      directory: directory.url,
      name: "app",
      launchID: launch,
      maximumFileSize: 1_000
    )
    let log = Log(.app, router: LogRouter(sinks: [file]))

    for number in 1...40 {
      log.info("Numbered", .int("number", number))
    }
    await file.flush()

    let names = try FileManager.default.contentsOfDirectory(atPath: directory.url.path())
    #expect(Set(names) == ["app.ndjson", "app.1.ndjson"])
    for url in [file.currentURL, file.previousURL] {
      #expect(try Data(contentsOf: url).count <= 1_000)
    }
    let numbers = try (Self.records(in: file.previousURL) + Self.records(in: file.currentURL))
      .map { ($0["fields"] as? [String: Any])?["number"] as? Int }
    #expect(numbers.last == 40)
    #expect(numbers.first != 1)
    #expect(numbers == numbers.indices.map { 40 - numbers.count + 1 + $0 })
  }

  @Test func readsTheNewestCompleteLinesAcrossBothFiles() async throws {
    defer { directory.remove() }
    let file = LogFile(
      directory: directory.url,
      name: "app",
      launchID: launch,
      maximumFileSize: 1_000
    )
    let log = Log(.app, router: LogRouter(sinks: [file]))
    for number in 1...12 {
      log.info("Numbered", .int("number", number))
    }

    let tail = try await file.recentTail(maximumBytes: 1_200)

    #expect(tail.count <= 1_200)
    #expect(tail.last == 0x0A)
    let lines = tail.split(separator: 0x0A)
    let numbers = try lines.map { line in
      let record = try #require(
        try JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
      )
      return (record["fields"] as? [String: Any])?["number"] as? Int
    }
    // Each file holds six lines, so the newest twelve span both, and the tail reaches back into
    // the previous file.
    #expect(numbers.last == 12)
    #expect(numbers.contains(6))
    #expect(numbers == numbers.indices.map { 12 - numbers.count + 1 + $0 })
  }

  @Test func hasAnEmptyTailBeforeAnythingIsWritten() async throws {
    defer { directory.remove() }
    let file = LogFile(directory: directory.url, name: "app", launchID: launch)

    #expect(try await file.recentTail(maximumBytes: 1_000).isEmpty)
  }

  @Test func appendsToTheFileAnEarlierLaunchWrote() async throws {
    defer { directory.remove() }
    let later = UUID()
    let earlier = LogFile(directory: directory.url, name: "app", launchID: launch)
    Log(.app, router: LogRouter(sinks: [earlier])).info("Earlier")
    await earlier.flush()

    let current = LogFile(directory: directory.url, name: "app", launchID: later)
    Log(.app, router: LogRouter(sinks: [current])).info("Later")
    await current.flush()

    let records = try Self.records(in: current.currentURL)
    #expect(records.map { $0["launch"] as? String } == [launch.uuidString, later.uuidString])
  }

  private static func records(in url: URL) throws -> [[String: Any]] {
    try Data(contentsOf: url).split(separator: 0x0A)
      .map { line in
        try #require(try JSONSerialization.jsonObject(with: Data(line)) as? [String: Any])
      }
  }
}

// A directory of its own for each test, removed when the test ends.
struct TemporaryDirectory {
  let url = URL.temporaryDirectory.appending(
    path: "ScreenrKitTests-\(UUID().uuidString)",
    directoryHint: .isDirectory
  )

  func remove() {
    do {
      try FileManager.default.removeItem(at: url)
    } catch CocoaError.fileNoSuchFile {
      // The test wrote nothing.
    } catch {
      Issue.record(error, "Could not remove \(url.path())")
    }
  }
}
