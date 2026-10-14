import Foundation
import os

// A rolling NDJSON log, one JSON object per line, that the feedback form attaches. Entries queue
// on an ordered stream that one long-lived task writes, so logging never waits on the disk. When
// the current file would pass its size limit, it becomes the previous file, replacing the one
// before it, so the log keeps at most two files.
public final class LogFile: LogSink {
  public let currentURL: URL
  public let previousURL: URL
  private let minimumLevel: LogLevel
  private let commands: AsyncStream<Command>.Continuation
  private let writer: Task<Void, Never>

  private enum Command: Sendable {
    case append(LogEntry)
    case flush(CheckedContinuation<Void, Never>)
    case tail(maximumBytes: Int, CheckedContinuation<Data, any Error>)
  }

  // The app's log directory in its app group container, which the notification extension
  // shares. Each process writes a file of its own name there.
  public static func directory(appGroup: String) -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appending(path: "Library/Logs/Screenr", directoryHint: .isDirectory)
  }

  public init(
    directory: URL,
    name: String,
    launchID: UUID = UUID(),
    maximumFileSize: Int = 256 * 1024,
    minimumLevel: LogLevel = .info
  ) {
    currentURL = directory.appending(path: "\(name).ndjson")
    previousURL = directory.appending(path: "\(name).1.ndjson")
    self.minimumLevel = minimumLevel
    let (stream, commands) = AsyncStream.makeStream(of: Command.self)
    self.commands = commands
    writer = Task { [currentURL, previousURL] in
      var file = Writer(
        directory: directory,
        current: currentURL,
        previous: previousURL,
        launchID: launchID.uuidString,
        maximumFileSize: maximumFileSize
      )
      for await command in stream {
        switch command {
        case .append(let entry): file.append(entry)
        case .flush(let done): done.resume()
        case .tail(let maximumBytes, let done):
          done.resume(with: Result { try file.tail(maximumBytes) })
        }
      }
      file.close()
    }
  }

  deinit {
    commands.finish()
  }

  public func record(_ entry: LogEntry) {
    guard entry.level >= minimumLevel else { return }
    commands.yield(.append(entry))
  }

  // Returns once every entry recorded before the call is in the file.
  public func flush() async {
    await withCheckedContinuation { done in
      if case .terminated = commands.yield(.flush(done)) { done.resume() }
    }
  }

  // The newest complete lines, at most maximumBytes of them, from the previous file and the
  // current one, after every entry recorded before the call.
  public func recentTail(maximumBytes: Int) async throws -> Data {
    try await withCheckedThrowingContinuation { done in
      if case .terminated = commands.yield(.tail(maximumBytes: maximumBytes, done)) {
        done.resume(throwing: CancellationError())
      }
    }
  }
}

// The file state, which only the writer task touches.
private struct Writer {
  private static let log = os.Logger(subsystem: Log.subsystem, category: "log-file")

  let directory: URL
  let current: URL
  let previous: URL
  let launchID: String
  let maximumFileSize: Int
  private var handle: FileHandle?
  private var size = 0
  private let encoder = JSONEncoder()

  init(directory: URL, current: URL, previous: URL, launchID: String, maximumFileSize: Int) {
    self.directory = directory
    self.current = current
    self.previous = previous
    self.launchID = launchID
    self.maximumFileSize = maximumFileSize
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  }

  // A failed write loses that line, and the next one starts over with a fresh handle. The
  // failure goes only to the unified log, since logging it through Log would come back here.
  mutating func append(_ entry: LogEntry) {
    do {
      var line = try encoder.encode(Record(entry, launchID: launchID))
      line.append(0x0A)
      if size > 0, size + line.count > maximumFileSize {
        try rotate()
      }
      let handle = try openHandle()
      try handle.write(contentsOf: line)
      size += line.count
    } catch {
      Self.log.error(
        "Could not write a log line: \(LogField.error(error).value.description, privacy: .public)"
      )
      close()
    }
  }

  func tail(_ maximumBytes: Int) throws -> Data {
    var data = Data()
    for url in [previous, current] {
      do {
        data.append(try Data(contentsOf: url))
      } catch CocoaError.fileReadNoSuchFile {
        continue
      }
    }
    guard data.count > maximumBytes else { return data }
    // Cut at a line boundary, so the tail holds only complete lines.
    let start = data.count - maximumBytes
    let suffix = data[start...]
    if data[start - 1] == 0x0A { return Data(suffix) }
    guard let newline = suffix.firstIndex(of: 0x0A) else { return Data() }
    return Data(suffix[(newline + 1)...])
  }

  mutating func close() {
    guard let handle else { return }
    self.handle = nil
    do {
      try handle.close()
    } catch {
      Self.log.error(
        "Could not close the log file: \(LogField.error(error).value.description, privacy: .public)"
      )
    }
  }

  private mutating func openHandle() throws -> FileHandle {
    if let handle { return handle }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: current.path()) {
      guard FileManager.default.createFile(atPath: current.path(), contents: nil) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: current.path()])
      }
    }
    let handle = try FileHandle(forWritingTo: current)
    size = Int(try handle.seekToEnd())
    self.handle = handle
    return handle
  }

  private mutating func rotate() throws {
    close()
    do {
      try FileManager.default.removeItem(at: previous)
    } catch CocoaError.fileNoSuchFile {
      // There was no previous file.
    }
    try FileManager.default.moveItem(at: current, to: previous)
    size = 0
  }
}

// One line of the file.
private struct Record: Encodable {
  let time: String
  let level: String
  let category: String
  let message: String
  let launch: String
  let fields: [String: LogField.Value]

  init(_ entry: LogEntry, launchID: String) {
    time = entry.date.ISO8601Format(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    level = entry.level.name
    category = entry.category.name
    message = entry.message
    launch = launchID
    fields = Dictionary(
      entry.fields.map { ($0.name, $0.value) },
      uniquingKeysWith: { _, last in last }
    )
  }
}
