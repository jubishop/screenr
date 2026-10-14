import Foundation
import Observation

// The Send feedback form in Settings: the member writes a message and can attach a few
// screenshots, and sending adds the recent log tails. Release builds send it to Sentry as user
// feedback. Screenr Dev never starts Sentry, so outside the fixture API its form explains that
// TestFlight builds send feedback, and Send stays off.
@MainActor
@Observable
public final class FeedbackModel {
  public enum Phase: Hashable, Sendable {
    case composing
    // Reading and downscaling chosen screenshots.
    case attaching
    case sending
    case sent
  }

  public enum Availability: Hashable, Sendable {
    case available
    // Screenr Dev, which sends no feedback.
    case unavailable
  }

  public struct Screenshot: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let jpeg: Data
  }

  public static let maximumScreenshots = 3
  // Each log's tail is at most this size, the size at which a log file rotates.
  static let logTailBytes = 256 * 1024

  public var message = ""
  public private(set) var screenshots: [Screenshot] = []
  public private(set) var phase = Phase.composing
  // Why the last attachment or send failed, in words for the member.
  public private(set) var failure: String?

  @ObservationIgnored private let service: FeedbackService

  public init(service: FeedbackService) {
    self.service = service
  }

  public var availability: Availability {
    service.sender == nil ? .unavailable : .available
  }

  public var remainingScreenshots: Int {
    Self.maximumScreenshots - screenshots.count
  }

  public var canSend: Bool {
    availability == .available && phase == .composing && !trimmedMessage.isEmpty
  }

  // Whether closing the form would lose a draft or a send in progress.
  public var hasDraft: Bool {
    switch phase {
    case .attaching, .sending: true
    case .composing: !trimmedMessage.isEmpty || !screenshots.isEmpty
    case .sent: false
    }
  }

  // Attaches the screenshots the member chose, up to the limit, once each `load` reads one from
  // the library, which can take a moment for an image kept in iCloud.
  public func attach(_ loads: [@Sendable () async throws -> Data?]) async {
    guard phase == .composing, !loads.isEmpty else { return }
    phase = .attaching
    failure = nil
    defer { phase = .composing }
    var failed = 0
    for load in loads.prefix(remainingScreenshots) {
      do {
        guard let image = try await load() else {
          failed += 1
          continue
        }
        let jpeg = try await ScreenshotPreparation.jpeg(from: image)
        screenshots.append(Screenshot(id: UUID(), jpeg: jpeg))
      } catch {
        Log.app.warning("A feedback screenshot could not be attached", .error(error))
        failed += 1
      }
    }
    switch failed {
    case 0: break
    case 1: failure = "A screenshot could not be attached. Try another."
    default: failure = "\(failed) screenshots could not be attached. Try others."
    }
  }

  public func remove(_ id: Screenshot.ID) {
    guard phase == .composing else { return }
    screenshots.removeAll { $0.id == id }
  }

  // Sends the message, the screenshots, and each log's recent tail. A log that cannot be read
  // stays behind rather than holding up the member's feedback.
  public func send() async {
    guard canSend, let sender = service.sender else { return }
    phase = .sending
    failure = nil
    let message = trimmedMessage
    let screenshots = screenshots.map(\.jpeg)
    Log.app.info("Sending feedback", .int("screenshots", screenshots.count))
    var logs: [LogTail] = []
    if let logFile = service.logFile {
      do {
        logs = try await logFile.recentTails(maximumBytes: Self.logTailBytes)
          .filter { !$0.data.isEmpty }
      } catch {
        Log.app.warning("Feedback goes without its log tails", .error(error))
      }
    }
    do {
      try sender.send(Feedback(message: message, screenshots: screenshots, logs: logs))
    } catch {
      Log.app.warning("Feedback could not be sent", .error(error))
      phase = .composing
      failure = "Your feedback could not be sent. Try again."
      return
    }
    self.message = ""
    self.screenshots = []
    phase = .sent
  }

  private var trimmedMessage: String {
    message.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
