import Foundation

// Under the fixture API, feedback goes to the request log instead of Sentry, as one line with its
// message, how many screenshots it has, and which logs' tails it carries, keys sorted:
// `FEEDBACK {"logs":["app"],"message":"Posters load slowly","screenshots":1}`.
struct FixtureFeedback: FeedbackSender {
  let log: FixtureRequestLog?

  func send(_ feedback: Feedback) throws {
    let body: JSONValue = [
      "message": .string(feedback.message),
      "screenshots": .integer(feedback.screenshots.count),
      "logs": .array(feedback.logs.map { .string($0.name) }),
    ]
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try log?.record("FEEDBACK " + String(decoding: try encoder.encode(body), as: UTF8.self))
  }
}
