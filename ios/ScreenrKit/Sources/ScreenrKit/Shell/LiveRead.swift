import Foundation
import Observation

// A member screen's model: its `screen` read, kept current while it shows.
public typealias ScreenModel = LiveRead<Screen>

// A GET request's result, kept current as the web keeps an open page:
//
// - While its view is visible and the app is active, it reads when the view
//   appears and every three seconds after. The client sends the cached
//   version's ETag, and an unchanged result keeps `phase` as it was.
// - It stops in the background or when the view disappears, and reads again
//   when either returns, and when a push notification arrives.
// - Each read gives up after ten seconds. A failed read replaces the content
//   with the error until a read succeeds. Passing failures, such as timeouts,
//   rate limits, server errors, and network loss, keep polling. A permanent
//   error stops polling until `refresh()` or the view's return reads again.
//
// The shell's views report visibility, the app's activity, and pull-to-refresh;
// a feature view renders `phase` and calls `refresh()` after a write. Screens
// use `ScreenModel`; other live reads, such as the notifications sheet's, use
// `LiveRead` with their request.
@MainActor
@Observable
public final class LiveRead<Value: Decodable & Hashable & Sendable> {
  public enum Phase: Hashable, Sendable {
    case loading
    case loaded(Value)
    case failed(APIError)
  }

  // What the next read sends, which a read's value can move, as a paged
  // screen's window does.
  @ObservationIgnored public private(set) var request: APIRequest<Value>
  public private(set) var phase: Phase = .loading

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let onLoad: @MainActor (Value) -> Void
  @ObservationIgnored private let follow:
    @MainActor (Value, APIRequest<Value>) -> APIRequest<Value>?
  @ObservationIgnored private var visible = false
  @ObservationIgnored private var active = false
  @ObservationIgnored private(set) var pollTask: Task<Void, Never>?
  @ObservationIgnored private var pollGeneration = 0
  @ObservationIgnored private var readTask: Task<Void, Never>?
  // Counts reads, so only the newest one's result applies.
  @ObservationIgnored private var readGeneration = 0

  // `onLoad` sees every value a read returns, such as for the bell's count.
  // `follow` names the request that reads after a value, given the request
  // that read it, or returns nil to read the same again.
  public init(
    _ request: APIRequest<Value>,
    api: any ScreenrAPI,
    clock: any Clock<Duration> = ContinuousClock(),
    onLoad: @escaping @MainActor (Value) -> Void = { _ in },
    follow: @escaping @MainActor (Value, APIRequest<Value>) -> APIRequest<Value>? = { _, _ in nil }
  ) {
    self.request = request
    self.api = api
    self.clock = clock
    self.follow = follow
    self.onLoad = onLoad
  }

  // The loaded value, or nil while loading or after a failed read.
  public var value: Value? {
    guard case .loaded(let value) = phase else { return nil }
    return value
  }

  private var isLive: Bool { visible && active }

  // The view is on screen: read now, then poll while the app is active.
  public func appeared(appActive: Bool) {
    visible = true
    active = appActive
    restart()
  }

  public func disappeared() {
    visible = false
    stop()
  }

  // The app became active, or left the foreground or became inactive.
  public func appActivityChanged(_ isActive: Bool) {
    guard isActive != active else { return }
    active = isActive
    if isActive { restart() } else { stop() }
  }

  // Reads now, for pull-to-refresh, Try again, or after a write. A read
  // already in flight may have started before the write, so it is replaced.
  // Polling resumes if a permanent error had stopped it.
  public func refresh() async {
    await read(replacing: true)
    guard isLive, pollTask == nil, !isPermanentlyFailed else { return }
    startPolling(.later)
  }

  // Reads `request` now, and later reads follow from it, such as a paged
  // screen's Show older.
  public func read(_ request: APIRequest<Value>) async {
    self.request = request
    await refresh()
  }

  // Reads now if the view is live, such as when a push notification arrives
  // or a write elsewhere changes the screen. A read already in flight may
  // have started too early, so it is replaced.
  public func refreshIfLive() {
    restart(.replacing)
  }

  private var isPermanentlyFailed: Bool {
    guard case .failed(let error) = phase else { return false }
    return error.isPermanent
  }

  private func restart(_ first: FirstRead = .joining) {
    guard isLive else { return }
    pollTask?.cancel()
    startPolling(first)
  }

  private func stop() {
    pollTask?.cancel()
    pollTask = nil
    // A read cut off by the background ends as cancelled, which keeps the
    // data. One that answers anyway, such as one already on its way as the
    // session ends, never applies.
    readTask?.cancel()
    readGeneration += 1
  }

  // How polling begins: at once, with the read in flight or a new one, or
  // after an interval.
  private enum FirstRead {
    case joining
    case replacing
    case later
  }

  private func startPolling(_ first: FirstRead) {
    pollGeneration += 1
    let generation = pollGeneration
    pollTask = Task {
      await poll(first)
      if pollGeneration == generation { pollTask = nil }
    }
  }

  // Every read after the interval repeats the last one, so it is a poll.
  private func poll(_ first: FirstRead) async {
    var next = first
    var trigger = RequestTrigger.demand
    while !Task.isCancelled {
      if next != .later {
        await read(replacing: next == .replacing, trigger: trigger)
        if isPermanentlyFailed || Task.isCancelled { return }
      }
      next = .joining
      trigger = .poll
      do {
        try await clock.sleep(for: LiveReadTiming.interval)
      } catch {
        return
      }
    }
  }

  // Joins the read in flight, or starts one. Replacing cancels the read in
  // flight, whose result then never applies.
  private func read(replacing: Bool = false, trigger: RequestTrigger = .demand) async {
    if let readTask {
      guard replacing else {
        await readTask.value
        return
      }
      readTask.cancel()
    }
    readGeneration += 1
    let generation = readGeneration
    let task = Task { await load(trigger, generation: generation) }
    readTask = task
    await task.value
    if readTask == task { readTask = nil }
  }

  private func load(_ trigger: RequestTrigger, generation: Int) async {
    let sent = request
    let result = await Self.fetch(sent.triggered(by: trigger), api: api, clock: clock)
    guard generation == readGeneration else { return }
    switch result {
    case .success(let value):
      if let next = follow(value, sent) { request = next }
      if phase != .loaded(value) { phase = .loaded(value) }
      onLoad(value)
    case .failure(let error) where error.kind == .cancelled:
      break
    case .failure(let error):
      phase = .failed(error)
    }
  }

  private enum Outcome: Sendable {
    case response(Result<Value, APIError>)
    case expired
    case stopped
  }

  // The value, or a timeout once the deadline passes. The request carries
  // its ID into the timeout.
  nonisolated private static func fetch(
    _ request: APIRequest<Value>,
    api: any ScreenrAPI,
    clock: any Clock<Duration>
  ) async -> Result<Value, APIError> {
    await withTaskGroup(of: Outcome.self) { group in
      group.addTask {
        do throws(APIError) {
          return .response(.success(try await api.send(request)))
        } catch {
          return .response(.failure(error))
        }
      }
      group.addTask {
        do {
          try await clock.sleep(for: LiveReadTiming.deadline)
          return .expired
        } catch {
          return .stopped
        }
      }
      var expired = false
      while let outcome = await group.next() {
        switch outcome {
        case .response(let result):
          group.cancelAll()
          guard expired, case .failure(let error) = result, error.kind == .cancelled else {
            return result
          }
          return .failure(APIError(kind: .timedOut, requestID: error.requestID))
        case .expired:
          expired = true
          group.cancelAll()
        case .stopped:
          continue
        }
      }
      return .failure(APIError(kind: .cancelled, requestID: ""))
    }
  }
}

// How often a live read polls, and how long each read waits, as on the web.
public enum LiveReadTiming {
  public static let interval: Duration = .seconds(3)
  public static let deadline: Duration = .seconds(10)
}

extension LiveRead where Value == Screen {
  // The screen at a member path, such as `/titles/tv/201`. A paged screen,
  // the friends feed or a profile, starts from its newest page, and each
  // read moves later ones to the window it names.
  public convenience init(
    path: String,
    paged: Bool = false,
    api: any ScreenrAPI,
    clock: any Clock<Duration> = ContinuousClock(),
    onLoad: @escaping @MainActor (Screen) -> Void = { _ in }
  ) {
    self.init(
      .screen(path: paged ? HistoryWindow.newest.path(path) : path),
      api: api,
      clock: clock,
      onLoad: onLoad,
      follow: { screen, sent in
        guard let page = screen.historyPage, let path = sent.query["path"] else { return nil }
        return .screen(path: HistoryWindow(after: page).path(path), visit: sent.visit)
      }
    )
  }

  // The member path the screen API reads, with a paged screen's window.
  public var path: String? { request.query["path"] }

  // Show older: reads the window extended by the page before the loaded
  // page's start, and later reads keep it.
  public func showOlder() async {
    guard let since = screen?.historyPage?.since, let path else { return }
    await read(.screen(path: HistoryWindow.before(since).path(path), visit: request.visit))
  }

  // The loaded screen, or nil while loading or after a failed read.
  public var screen: Screen? { value }

  // The member path that a redirect screen, such as an old conversation
  // link's, names.
  public var redirectPath: String? {
    guard case .redirect(let path) = screen?.content else { return nil }
    return path
  }
}
