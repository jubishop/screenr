import Foundation
import Synchronization

#if canImport(UIKit)
import UIKit
#endif

// The values used most recently, by key, up to a number of them and a total
// size, such as the client's reads or decoded avatars. Each value's size is
// the caller's measure of it, such as a response body's bytes. The newest
// value stays even when it alone passes the size limit. Everything goes when
// the system warns that memory is low.
final class RecentCache<Value: Sendable>: Sendable {
  private struct Entry {
    let value: Value
    let bytes: Int
  }

  private struct State {
    var entries: [String: Entry] = [:]
    // Keys from the least to the most recently used.
    var order: [String] = []
    var bytes = 0
  }

  // The memory warning's observer holds the state, not the cache, so the
  // cache can stop observing when it goes.
  private final class Storage: Sendable {
    let state = Mutex(State())
  }

  private let limits: CacheLimits
  private let storage = Storage()
  private let notifications: NotificationCenter
  private let observer: Mutex<any NSObjectProtocol>

  // `notifications` posts the system's memory warnings; tests post their own.
  init(limits: CacheLimits, notifications: NotificationCenter = .default) {
    self.limits = limits
    self.notifications = notifications
    let storage = storage
    observer = Mutex(
      notifications.addObserver(forName: .memoryWarning, object: nil, queue: nil) { _ in
        storage.state.withLock { $0 = State() }
      }
    )
  }

  deinit {
    notifications.removeObserver(observer.withLock { $0 })
  }

  // The value for `key`, which becomes the most recently used.
  func value(for key: String) -> Value? {
    storage.state.withLock { state in
      guard let entry = state.entries[key] else { return nil }
      state.order.removeAll { $0 == key }
      state.order.append(key)
      return entry.value
    }
  }

  // Keeps `value` for `key` in place of any earlier one, then lets the least
  // recently used values go until the rest fit the limits.
  func store(_ value: Value, bytes: Int, for key: String) {
    storage.state.withLock { state in
      if let earlier = state.entries.updateValue(Entry(value: value, bytes: bytes), forKey: key) {
        state.bytes -= earlier.bytes
        state.order.removeAll { $0 == key }
      }
      state.order.append(key)
      state.bytes += bytes
      while state.order.count > 1,
        state.order.count > limits.count || state.bytes > limits.bytes
      {
        let oldest = state.order.removeFirst()
        if let entry = state.entries.removeValue(forKey: oldest) { state.bytes -= entry.bytes }
      }
    }
  }

  func removeAll() {
    storage.state.withLock { $0 = State() }
  }
}

// How many values a `RecentCache` keeps, and how many bytes they may take.
struct CacheLimits: Hashable, Sendable {
  let count: Int
  let bytes: Int
}

extension Notification.Name {
  // iOS's warning that the process is low on memory. The Mac, where the
  // package's tests run, has none, so there the name is Screenr's own.
  static let memoryWarning: Notification.Name = {
    #if canImport(UIKit)
    UIApplication.didReceiveMemoryWarningNotification
    #else
    Notification.Name("ScreenrMemoryWarning")
    #endif
  }()
}
