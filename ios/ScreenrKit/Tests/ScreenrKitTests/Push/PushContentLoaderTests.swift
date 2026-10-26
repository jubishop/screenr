import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// The notification extension's alert for one push: it reads the notification
// and its sender's photo, and delivers once, keeping the generic alert when
// the notification is hidden, the read fails, or iOS's time runs out first.
@Suite(.timeLimit(.minutes(1)))
struct PushContentLoaderTests {
  private let photo = Data("jpeg".utf8)

  @Test func aVisibleNotificationBecomesARichAlertWithTheSendersPhoto() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/comment")])
    let photos = PhotoRequests(answer: .success(photo))
    let deliveries = Deliveries()

    await PushContentLoader(deliver: deliveries.record)
      .load(PushTap(notificationID: "18"), api: api, avatars: photos.avatars)

    let content = PushContent(try pushNotification("comment"))
    #expect(deliveries.alerts == [.rich(content, avatar: photo)])
    #expect(
      api.requests == [.init(method: .get, action: "notification", query: ["id": "18"], body: nil)]
    )
    #expect(photos.requested == ["user-ben/8fc275dfeaca5cf8"])
  }

  @Test func aSenderWithoutAPhotoLoadsNone() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/friend-request")])
    let photos = PhotoRequests(answer: .success(photo))
    let deliveries = Deliveries()

    await PushContentLoader(deliver: deliveries.record)
      .load(PushTap(notificationID: "14"), api: api, avatars: photos.avatars)

    let content = PushContent(try pushNotification("friend-request"))
    #expect(deliveries.alerts == [.rich(content, avatar: nil)])
    #expect(photos.requested.isEmpty)
  }

  @Test func aPhotoThatFailsLeavesTheAlertWithoutAnAvatar() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/spoiler")])
    let photos = PhotoRequests(answer: .failure(URLError(.badServerResponse)))
    let deliveries = Deliveries()

    await PushContentLoader(deliver: deliveries.record)
      .load(PushTap(notificationID: "20"), api: api, avatars: photos.avatars)

    let content = PushContent(try pushNotification("spoiler"))
    #expect(deliveries.alerts == [.rich(content, avatar: nil)])
    #expect(content.body.hasSuffix(". Contains spoilers."))
  }

  @Test func aHiddenNotificationKeepsTheGenericAlert() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/hidden")])
    let photos = PhotoRequests(answer: .success(photo))
    let deliveries = Deliveries()

    await PushContentLoader(deliver: deliveries.record)
      .load(PushTap(notificationID: "19"), api: api, avatars: photos.avatars)

    #expect(deliveries.alerts == [.generic(.hidden)])
    #expect(photos.requested.isEmpty)
  }

  @Test(arguments: [
    APIError.Kind.offline, .signedOut, .server(status: 503), .updateRequired(minimumBuild: 9),
  ])
  func aFailedReadKeepsTheGenericAlert(_ failure: APIError.Kind) async {
    let api = RecordingAPI(["notification": .failure(failure)])
    let deliveries = Deliveries()

    await PushContentLoader(deliver: deliveries.record)
      .load(
        PushTap(notificationID: "18"),
        api: api,
        avatars: PhotoRequests(answer: .success(photo)).avatars
      )

    #expect(deliveries.alerts == [.generic(.failed)])
  }

  @Test func aPayloadWithoutANotificationKeepsTheGenericAlert() async {
    let api = RecordingAPI()
    let deliveries = Deliveries()

    await PushContentLoader(deliver: deliveries.record)
      .load(
        PushTap(userInfo: [:]),
        api: api,
        avatars: PhotoRequests(answer: .success(photo)).avatars
      )

    #expect(deliveries.alerts == [.generic(.missingID)])
    #expect(api.requests.isEmpty)
  }

  @Test func servicesThatCannotStartKeepTheGenericAlert() {
    let deliveries = Deliveries()

    PushContentLoader(deliver: deliveries.record).unavailable(KeychainError(status: -25308))

    #expect(deliveries.alerts == [.generic(.failed)])
  }

  @Test func timeRunningOutDuringTheReadKeepsTheGenericAlert() async {
    let api = ScriptedAPI([.hang])
    let deliveries = Deliveries()
    let loader = PushContentLoader(deliver: deliveries.record)
    let load = Task {
      await loader.load(
        PushTap(notificationID: "18"),
        api: api,
        avatars: PhotoRequests(answer: .success(photo)).avatars
      )
    }
    await api.waitForReads(1)

    loader.timeWillExpire()
    #expect(deliveries.alerts == [.generic(.timedOut)])

    // The read that iOS's time cut short delivers nothing more.
    load.cancel()
    await finish(load)
    #expect(deliveries.alerts == [.generic(.timedOut)])
  }

  @Test func timeRunningOutDuringThePhotoShowsTheAlertWithoutIt() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/comment")])
    let photos = PhotoRequests(answer: nil)
    let deliveries = Deliveries()
    let loader = PushContentLoader(deliver: deliveries.record)
    let load = Task {
      await loader.load(PushTap(notificationID: "18"), api: api, avatars: photos.avatars)
    }
    await photos.waitForRequest()

    loader.timeWillExpire()
    let content = PushContent(try pushNotification("comment"))
    #expect(deliveries.alerts == [.rich(content, avatar: nil)])

    load.cancel()
    await finish(load)
    #expect(deliveries.alerts == [.rich(content, avatar: nil)])
  }

  @Test func timeRunningOutAfterDeliveryChangesNothing() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/hidden")])
    let deliveries = Deliveries()
    let loader = PushContentLoader(deliver: deliveries.record)

    await loader.load(
      PushTap(notificationID: "19"),
      api: api,
      avatars: PhotoRequests(answer: .success(photo)).avatars
    )
    loader.timeWillExpire()

    #expect(deliveries.alerts == [.generic(.hidden)])
  }
}

// The alerts a loader delivered, in order.
final class Deliveries: Sendable {
  private let delivered = Mutex<[PushAlert]>([])

  var alerts: [PushAlert] { delivered.withLock { $0 } }

  @Sendable func record(_ alert: PushAlert) {
    delivered.withLock { $0.append(alert) }
  }
}

// Profile photo loads for avatars: each answers with `answer`, or, when it is
// nil, waits until its task is cancelled.
final class PhotoRequests: Sendable {
  private struct State {
    var requested: [String] = []
    var nextID = 0
    var watchers: [(id: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  private let answer: Result<Data, URLError>?
  private let state = Mutex(State())

  init(answer: Result<Data, URLError>?) {
    self.answer = answer
  }

  // Each photo asked for, as `<user ID>/<version>`.
  var requested: [String] { state.withLock { $0.requested } }

  var avatars: PushAvatars {
    PushAvatars { userId, version in
      let watchers = self.state.withLock { state in
        state.requested.append("\(userId)/\(version)")
        defer { state.watchers.removeAll() }
        return state.watchers.map(\.continuation)
      }
      for watcher in watchers { watcher.resume() }
      guard let answer = self.answer else {
        // An empty stream ends only when the task is cancelled.
        let stream = AsyncStream<Never> { _ in }
        for await _ in stream {}
        throw CancellationError()
      }
      return try answer.get()
    }
  }

  // Waits until a photo has been asked for.
  func waitForRequest() async {
    let id = state.withLock { state in
      state.nextID += 1
      return state.nextID
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let waiting = state.withLock { state in
          guard !Task.isCancelled, state.requested.isEmpty else { return false }
          state.watchers.append((id, continuation))
          return true
        }
        if !waiting { continuation.resume() }
      }
    } onCancel: {
      let watcher = state.withLock { state in
        let watcher = state.watchers.first { $0.id == id }
        state.watchers.removeAll { $0.id == id }
        return watcher
      }
      watcher?.continuation.resume()
    }
  }
}
