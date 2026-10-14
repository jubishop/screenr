import Foundation
import ScreenrKit
import Synchronization

// A fixture's response body decoded as a screen.
func screen(_ fixture: String) throws -> Screen {
  try ScreenrJSON.decoder().decode(Screen.self, from: try TestFixtures.body(fixture))
}

// Waits for a task, and cancels it if the test is cancelled, such as at its
// time limit, so a task that never ends fails the test instead of hanging it.
func finish(_ task: Task<Void, Never>) async {
  await withTaskCancellationHandler {
    await task.value
  } onCancel: {
    task.cancel()
  }
}

// A clock that moves only when a test advances it, so polling tests never wait
// for real time. Cancelling a test that waits on it, as its time limit does,
// ends the wait, so a wait that is never met fails instead of hanging.
final class TestClock: Clock {
  struct Instant: InstantProtocol {
    let offset: Duration

    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (left: Instant, right: Instant) -> Bool { left.offset < right.offset }
  }

  private struct Sleeper {
    let id: Int
    let deadline: Instant
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var now = Instant(offset: .zero)
    var nextID = 0
    var sleepers: [Sleeper] = []
    var watchers: [(id: Int, deadline: Instant, continuation: CheckedContinuation<Void, Never>)] =
      []
  }

  private let state = Mutex(State())

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }
  // How many sleeps are waiting.
  var sleeping: Int { state.withLock { $0.sleepers.count } }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = newID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, any Error>) in
        let (outcome, watchers) = state.withLock {
          state -> (Result<Bool, any Error>, [CheckedContinuation<Void, Never>]) in
          if Task.isCancelled { return (.failure(CancellationError()), []) }
          if deadline <= state.now { return (.success(true), []) }
          state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
          let woken = state.watchers.filter { $0.deadline == deadline }.map(\.continuation)
          state.watchers.removeAll { $0.deadline == deadline }
          return (.success(false), woken)
        }
        for watcher in watchers { watcher.resume() }
        switch outcome {
        case .success(true): continuation.resume()
        case .success(false): break
        case .failure(let error): continuation.resume(throwing: error)
        }
      }
    } onCancel: {
      let sleeper = state.withLock { state in
        let sleeper = state.sleepers.first { $0.id == id }
        state.sleepers.removeAll { $0.id == id }
        return sleeper
      }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  // Moves time forward and wakes every sleep that is due.
  func advance(by duration: Duration) {
    let due = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let due = state.sleepers.filter { $0.deadline <= now }
      state.sleepers.removeAll { $0.deadline <= now }
      return due
    }
    for sleeper in due { sleeper.continuation.resume() }
  }

  // Waits until something sleeps until `offset` from the clock's start.
  func waitForSleep(until offset: Duration) async {
    let deadline = Instant(offset: offset)
    let id = newID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let waiting = state.withLock { state in
          guard !Task.isCancelled, !state.sleepers.contains(where: { $0.deadline == deadline })
          else { return false }
          state.watchers.append((id, deadline, continuation))
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

  private func newID() -> Int {
    state.withLock { state in
      state.nextID += 1
      return state.nextID
    }
  }
}

// A screen API that answers from a script and records each screen path it
// reads. The last reply repeats once the script runs out.
final class ScriptedAPI: ScreenrAPI {
  enum Reply: Sendable {
    case screen(Screen)
    case failure(APIError.Kind)
    // Waits until the request is cancelled.
    case hang
  }

  private struct State {
    var replies: [Reply]
    var reads: [String] = []
    var nextID = 0
    var watchers: [(id: Int, count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  private let state: Mutex<State>

  init(_ replies: [Reply]) {
    state = Mutex(State(replies: replies))
  }

  var reads: [String] { state.withLock { $0.reads } }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let (reply, requestID, watchers) = state.withLock { state in
      state.reads.append(request.query["path"] ?? request.endpoint.path)
      let reply = state.replies.count > 1 ? state.replies.removeFirst() : state.replies.first
      let count = state.reads.count
      let woken = state.watchers.filter { $0.count <= count }.map(\.continuation)
      state.watchers.removeAll { $0.count <= count }
      return (reply, "request-\(count)", woken)
    }
    for watcher in watchers { watcher.resume() }
    switch reply {
    case .screen(let screen):
      guard let response = screen as? Response else {
        throw APIError(kind: .invalidResponse, requestID: requestID)
      }
      return response
    case .failure(let kind):
      throw APIError(kind: kind, requestID: requestID)
    case .hang, nil:
      // An empty stream ends only when the task is cancelled.
      let stream = AsyncStream<Never> { _ in }
      for await _ in stream {}
      throw APIError(kind: .cancelled, requestID: requestID)
    }
  }

  // Waits until the API has received `count` reads.
  func waitForReads(_ count: Int) async {
    let id = state.withLock { state in
      state.nextID += 1
      return state.nextID
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let waiting = state.withLock { state in
          guard !Task.isCancelled, state.reads.count < count else { return false }
          state.watchers.append((id, count, continuation))
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
