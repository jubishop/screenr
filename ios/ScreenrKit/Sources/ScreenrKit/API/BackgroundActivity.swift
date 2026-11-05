import Foundation

// Keeps the process running while work that already started finishes, after
// the member leaves the app or the share sheet, for as long as iOS allows,
// about half a minute. The network transport keeps a write running, so going
// to the background does not cut it off after the server applied it. The app
// and its extensions use `ProcessActivity`; tests record theirs.
public protocol BackgroundActivity: Sendable {
  // Runs `work`, asking iOS for time to finish it named by `reason`.
  func keepRunning<Value>(
    _ reason: String,
    during work: () async throws -> Value
  ) async rethrows -> Value
}

// iOS's expiring activity, which apps and their extensions both have. iOS
// runs its block on a queue of its own and suspends the process only after
// the block returns, so the block waits for the work. If iOS's time runs out
// first, it calls the block again with `expired`, and the first call returns
// at once; the work goes on until the suspension stops it.
public struct ProcessActivity: BackgroundActivity {
  public init() {}

  public func keepRunning<Value>(
    _ reason: String,
    during work: () async throws -> Value
  ) async rethrows -> Value {
    #if os(iOS)
    let finished = DispatchSemaphore(value: 0)
    ProcessInfo.processInfo.performExpiringActivity(withReason: reason) { expired in
      if expired {
        finished.signal()
      } else {
        finished.wait()
      }
    }
    defer { finished.signal() }
    #else
    // macOS, where only ScreenrKit's tests run, suspends no process.
    #endif
    return try await work()
  }
}
