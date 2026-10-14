import ScreenrKit
import Testing

// The web's messages for failed requests.
struct ErrorExplanationTests {
  @Test(
    arguments: [
      (APIError.Kind.offline, "Could not reach Screenr. Check your connection and try again."),
      (.timedOut, "The request timed out. Please try again."),
      (.server(status: 503), "Screenr is temporarily unavailable. Please try again in a moment."),
      (.invalidResponse, "Screenr is temporarily unavailable. Please try again in a moment."),
      (.rejected(status: 400), "Request failed. Please try again."),
      (.notFound, "Request failed. Please try again."),
      (.rateLimited, "Request failed. Please try again."),
    ]
  )
  func explainsEachKindOfFailure(kind: APIError.Kind, explanation: String) {
    #expect(APIError(kind: kind, requestID: "request").explanation == explanation)
  }

  @Test func prefersTheServersMessage() {
    let error = APIError(kind: .notFound, message: "Title not found.", requestID: "request")

    #expect(error.explanation == "Title not found.")
    #expect(error.readExplanation == "Title not found.")
  }

  @Test func namesATimedOutRead() {
    #expect(
      APIError(kind: .timedOut, requestID: "request").readExplanation
        == "Refresh timed out. Please try again."
    )
  }
}
