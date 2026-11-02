import Foundation
import ScreenrKit
import Synchronization

// Answers each request from `answers` as it arrives, but holds a held
// request's answer until the test opens the gate, even after the request is
// cancelled, as a server that already has a request still answers it. Every
// request is held unless `holding` numbers the held ones in order of arrival,
// from 1. Tests open the gate before waiting for a held request to end.
final class GatedAPI: ScreenrAPI {
  private struct State {
    var arrived = 0
    var recorded = 0
    var opened = false
    var gates: [CheckedContinuation<Void, Never>] = []
    var nextID = 0
    var watchers: [(id: Int, count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  let answers: RecordingAPI
  private let held: Set<Int>?
  private let state = Mutex(State())

  init(_ answers: RecordingAPI, holding held: Set<Int>? = nil) {
    self.answers = answers
    self.held = held
  }

  var requests: [RecordingAPI.Sent] { answers.requests }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let number = state.withLock { state in
      state.arrived += 1
      return state.arrived
    }
    let answer: Result<Response, APIError>
    do throws(APIError) {
      answer = .success(try await answers.send(request))
    } catch {
      answer = .failure(error)
    }
    let watchers = state.withLock { state in
      state.recorded += 1
      let count = state.recorded
      let woken = state.watchers.filter { $0.count <= count }.map(\.continuation)
      state.watchers.removeAll { $0.count <= count }
      return woken
    }
    for watcher in watchers { watcher.resume() }
    if held?.contains(number) ?? true {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let open = state.withLock { state in
          if !state.opened { state.gates.append(continuation) }
          return state.opened
        }
        if open { continuation.resume() }
      }
    }
    return try answer.get()
  }

  // Lets every held answer, waiting or still to come, through.
  func open() {
    let gates = state.withLock { state in
      state.opened = true
      defer { state.gates = [] }
      return state.gates
    }
    for gate in gates { gate.resume() }
  }

  // Waits until `count` requests have arrived and been recorded.
  func waitForRequests(_ count: Int) async {
    let id = state.withLock { state in
      state.nextID += 1
      return state.nextID
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let waiting = state.withLock { state in
          guard !Task.isCancelled, state.recorded < count else { return false }
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
