import Foundation
import Sentry
import Synchronization
import Testing

@testable import ScreenrKit

// Starts Sentry clients whose URLSession answers every request locally, so a test reads the
// envelopes Sentry would have sent. Each client receives the options Telemetry builds, so its
// callbacks and privacy settings are the ones Release builds use.
final class SentryEnvelopeCapture: Sendable {
  struct Item {
    let type: String
    let payload: Data

    var json: [String: Any] {
      get throws {
        try #require(try JSONSerialization.jsonObject(with: payload) as? [String: Any])
      }
    }

    var text: String { String(decoding: payload, as: UTF8.self) }
  }

  struct Timeout: Error {}

  private let host = "\(UUID().uuidString.lowercased()).invalid"
  private let cache = TemporaryDirectory()
  private let reporters = Mutex<[HubReporter]>([])
  private let arrivals: AsyncStream<Void>

  init() {
    let (arrivals, continuation) = AsyncStream.makeStream(of: Void.self)
    self.arrivals = arrivals
    CapturingURLProtocol.listen(for: host, continuation)
  }

  // How many times Telemetry started Sentry.
  var starts: Int { reporters.withLock { $0.count } }

  // Starts a test client in place of the global SDK.
  func start(_ options: sending Options) -> any SentryReporter {
    let session = URLSessionConfiguration.ephemeral
    session.protocolClasses = [CapturingURLProtocol.self]
    options.dsn = "https://public@\(host)/1"
    options.urlSession = URLSession(configuration: session)
    options.cacheDirectoryPath = cache.url.path()
    options.sendClientReports = false
    options.enableAutoSessionTracking = false
    let reporter = HubReporter(options: options)
    reporters.withLock { $0.append(reporter) }
    return reporter
  }

  // Changes the scope a started client applies to events, for tests that plant data on it.
  func configureScope(_ configure: @escaping (Scope) -> Void) {
    for reporter in reporters.withLock({ $0 }) {
      reporter.configureScope(configure)
    }
  }

  // Adds a breadcrumb the way Sentry's own trackers do, through the hub and its callback.
  func addBreadcrumb(category: String, data: [String: String]) {
    for reporter in reporters.withLock({ $0 }) {
      reporter.add(makeBreadcrumb(category, data))
    }
  }

  // Starts and finishes a transaction directly on each started client.
  func recordTransaction(name: String, configure: (any Span) -> Void) {
    for reporter in reporters.withLock({ $0 }) {
      reporter.recordTransaction(
        TransactionContext(name: name, operation: "test"),
        configure: configure
      )
    }
  }

  // Sends everything the clients have queued and returns the items of every envelope.
  func items() throws -> [Item] {
    for reporter in reporters.withLock({ $0 }) {
      reporter.flush()
    }
    return try CapturingURLProtocol.bodies(for: host).flatMap(Self.items(in:))
  }

  func items(ofType type: String) throws -> [Item] {
    try items().filter { $0.type == type }
  }

  // Sentry hands finished transactions to a background queue before it sends them, so a flush
  // can come too early. This waits for each envelope to arrive until count items of the type
  // have, for at most ten seconds.
  func items(ofType type: String, count: Int) async throws -> [Item] {
    try await withThrowingTaskGroup(of: [Item].self) { group in
      group.addTask {
        var found = try self.items(ofType: type)
        var arrived = self.arrivals.makeAsyncIterator()
        while found.count < count, await arrived.next() != nil {
          found = try self.items(ofType: type)
        }
        return found
      }
      group.addTask {
        try await Task.sleep(for: .seconds(10))
        throw Timeout()
      }
      defer { group.cancelAll() }
      return try await group.next() ?? []
    }
  }

  func close() {
    for reporter in reporters.withLock({ $0 }) {
      reporter.close()
    }
    CapturingURLProtocol.forget(host)
    // A closed client can still be writing its installation file from a background queue, which
    // can make the removal fail. The directory is in the temporary directory, so the system
    // removes whatever is left.
    do {
      try FileManager.default.removeItem(at: cache.url)
    } catch {
      return
    }
  }

  private static func items(in body: Data) throws -> [Item] {
    let envelope = try gunzip(body)
    // The envelope header line, then each item: a header line, and a payload of the length the
    // header gives, or up to the next newline.
    var cursor = try #require(envelope.firstIndex(of: 0x0A)) + 1
    var items: [Item] = []
    while cursor < envelope.endIndex, let end = envelope[cursor...].firstIndex(of: 0x0A) {
      let header = try #require(
        try JSONSerialization.jsonObject(with: envelope[cursor..<end]) as? [String: Any]
      )
      let start = end + 1
      let length =
        header["length"] as? Int
        ?? (envelope[start...].firstIndex(of: 0x0A) ?? envelope.endIndex) - start
      let payload = envelope[start..<min(start + length, envelope.endIndex)]
      items.append(Item(type: header["type"] as? String ?? "", payload: Data(payload)))
      cursor = start + length + 1
    }
    return items
  }

  // Sentry gzips each envelope with no optional header fields: 10 header bytes, a raw DEFLATE
  // stream, and an 8-byte trailer.
  private static func gunzip(_ data: Data) throws -> Data {
    #expect(data.starts(with: [0x1F, 0x8B, 0x08, 0x00]))
    let deflated = Data(data.dropFirst(10).dropLast(8))
    return try (deflated as NSData).decompressed(using: .zlib) as Data
  }
}

// A breadcrumb with data, as Sentry's trackers make them.
func makeBreadcrumb(_ category: String, _ data: [String: Any]) -> Breadcrumb {
  let breadcrumb = Breadcrumb(level: .info, category: category)
  for (key, value) in data {
    breadcrumb.setData(value: value, key: key)
  }
  return breadcrumb
}

// The Sentry operations Telemetry uses, sent to a test hub instead of the global SDK. Sentry's
// hub and client lock their own state, as the global SDK relies on, so the reporter can share
// them across threads.
private final class HubReporter: SentryReporter, @unchecked Sendable {
  private let hub: SentryHub

  init(options: Options) {
    // The global SDK starts with the options' initial scope; so does this hub.
    hub = SentryHub(client: SentryClient(options: options), andScope: options.initialScope(Scope()))
  }

  func setUser(_ user: sending User?) {
    hub.setUser(user)
  }

  func add(_ breadcrumb: sending Breadcrumb) {
    hub.add(breadcrumb)
  }

  func capture(error: any Error, tags: [String: String]) {
    let scope = Scope(scope: hub.scope)
    scope.setTags(tags)
    hub.capture(error: error, scope: scope)
  }

  func log(_ level: SentryLog.Level, _ body: String, attributes: sending [String: Any]) {
    switch level {
    case .trace: hub.logger.trace(body, attributes: attributes)
    case .debug: hub.logger.debug(body, attributes: attributes)
    case .info: hub.logger.info(body, attributes: attributes)
    case .warn: hub.logger.warn(body, attributes: attributes)
    case .error: hub.logger.error(body, attributes: attributes)
    case .fatal: hub.logger.fatal(body, attributes: attributes)
    @unknown default: hub.logger.error(body, attributes: attributes)
    }
  }

  func recordTransaction(_ context: sending TransactionContext, configure: (any Span) -> Void) {
    configure(hub.startTransaction(transactionContext: context))
  }

  func configureScope(_ configure: @escaping (Scope) -> Void) {
    hub.configureScope(configure)
  }

  func flush() {
    hub.getClient()?.flush(timeout: 10)
  }

  func close() {
    hub.close()
  }
}

// Answers every request with an empty success and keeps its body, by host.
private final class CapturingURLProtocol: URLProtocol {
  private struct Inbox {
    var bodies: [Data] = []
    let arrivals: AsyncStream<Void>.Continuation
  }

  private static let inboxes = Mutex<[String: Inbox]>([:])

  static func listen(for host: String, _ arrivals: AsyncStream<Void>.Continuation) {
    inboxes.withLock { $0[host] = Inbox(arrivals: arrivals) }
  }

  static func bodies(for host: String) -> [Data] {
    inboxes.withLock { $0[host]?.bodies ?? [] }
  }

  static func forget(_ host: String) {
    let inbox = inboxes.withLock { $0.removeValue(forKey: host) }
    inbox?.arrivals.finish()
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let host = url.host(),
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    var body = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      body = Self.read(stream)
    }
    Self.inboxes.withLock { inboxes in
      inboxes[host]?.bodies.append(body)
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{}".utf8))
    client?.urlProtocolDidFinishLoading(self)
    Self.inboxes.withLock { $0[host] }?.arrivals.yield()
  }

  override func stopLoading() {}

  private static func read(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 16_384)
    while stream.hasBytesAvailable {
      let count = unsafe stream.read(&buffer, maxLength: buffer.count)
      guard count > 0 else { break }
      data.append(contentsOf: buffer[..<count])
    }
    return data
  }
}
