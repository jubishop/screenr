import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// The per-kind push settings in Settings. Each switch shows the choice being
// saved and ignores changes until its save finishes; the others stay usable.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct PushSettingsModelTests {
  private let saved = PushSettings(
    friendRequest: true,
    friendAccepted: true,
    comment: true,
    reply: true
  )

  @Test func readsTheAccountScreensSettings() throws {
    guard case .account(let page) = try screen("screen/account/default").content else {
      Issue.record("The account fixture is not an account screen")
      return
    }
    let settings = try #require(page.pushSettings)
    #expect(PushKind.allCases.map { settings.isOn($0) } == [true, true, true, true])
  }

  @Test func savesOneKindAndReadsAgain() async throws {
    let api = RecordingAPI(["push-settings": try .fixture("actions/push-settings/default")])
    let refresh = RefreshCounter()
    let model = PushSettingsModel(api: api) { await refresh.refresh() }
    #expect(model.isOn(.comment, saved: saved))

    await model.set(.comment, false)

    #expect(
      api.requests == [
        RecordingAPI.Sent(
          method: .post,
          action: "push-settings",
          query: [:],
          body: ["comment": false]
        )
      ]
    )
    #expect(refresh.count == 1)
    #expect(model.failure == nil)
    #expect(model.saving.isEmpty)
  }

  @Test(arguments: [
    (PushKind.friendRequest, "friendRequest"), (.friendAccepted, "friendAccepted"),
    (.comment, "comment"), (.reply, "reply"),
  ])
  func namesEachKind(kind: PushKind, key: String) async throws {
    let api = RecordingAPI(["push-settings": try .fixture("actions/push-settings/default")])
    let model = PushSettingsModel(api: api) {}

    await model.set(kind, true)

    #expect(api.requests.first?.body == .object([key: true]))
  }

  @Test func showsTheChoiceWhileItSaves() async throws {
    let api = HangingAPI()
    let model = PushSettingsModel(api: api) {}

    let saving = Task { await model.set(.reply, false) }
    await api.waitForRequest()
    #expect(model.isOn(.reply, saved: saved) == false)
    #expect(model.isOn(.comment, saved: saved))

    // A second change to the same kind waits for the first.
    await model.set(.reply, true)
    #expect(api.count == 1)

    saving.cancel()
    await saving.value
    #expect(model.isOn(.reply, saved: saved))
    #expect(model.failure == nil)
  }

  @Test func reportsAFailedSave() async {
    let api = RecordingAPI(["push-settings": .failure(.offline)])
    let refresh = RefreshCounter()
    let model = PushSettingsModel(api: api) { await refresh.refresh() }

    await model.set(.friendRequest, false)

    #expect(model.isOn(.friendRequest, saved: saved))
    // The server's message, which the fake names after the action.
    #expect(model.failure == "The push-settings failed.")
    #expect(refresh.count == 0)
  }
}

// An API whose requests wait until they are cancelled.
private final class HangingAPI: ScreenrAPI {
  private let requests = AsyncStream<Void>.makeStream()
  private let sent = Mutex(0)

  var count: Int { sent.withLock { $0 } }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    sent.withLock { $0 += 1 }
    requests.continuation.yield()
    let stream = AsyncStream<Never> { _ in }
    for await _ in stream {}
    throw APIError(kind: .cancelled, requestID: "request")
  }

  func waitForRequest() async {
    var iterator = requests.stream.makeAsyncIterator()
    _ = await iterator.next()
  }
}
