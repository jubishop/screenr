import Foundation

// What the Send feedback form sends: the member's message, their screenshots as JPEGs, and the
// recent log tails, which hold no user content.
public struct Feedback: Hashable, Sendable {
  public let message: String
  public let screenshots: [Data]
  public let logs: [LogTail]

  public init(message: String, screenshots: [Data], logs: [LogTail]) {
    self.message = message
    self.screenshots = screenshots
    self.logs = logs
  }
}

// Sends feedback. Release builds send it to Sentry as user feedback, with the opaque Screenr user
// ID and no name or email. Under the fixture API, it goes to the request log instead.
public protocol FeedbackSender: Sendable {
  func send(_ feedback: Feedback) throws
}

// Where the form sends feedback, and the log whose tails go with it. Screenr Dev has no sender
// outside the fixture API, since it never starts Sentry.
public struct FeedbackService: Sendable {
  public let sender: (any FeedbackSender)?
  public let logFile: LogFile?

  public init(sender: (any FeedbackSender)?, logFile: LogFile?) {
    self.sender = sender
    self.logFile = logFile
  }

  public static let none = FeedbackService(sender: nil, logFile: nil)
}
