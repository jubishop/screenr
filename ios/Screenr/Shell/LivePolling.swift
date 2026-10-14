import ScreenrKit
import SwiftUI

extension View {
  // Keeps a live read current while the view is visible and the app is
  // active: it reports appearing, disappearing, and the app's activity, reads
  // on pull-to-refresh, and reads when a push notification arrives.
  func livePolling<Value: Decodable & Hashable & Sendable>(_ model: LiveRead<Value>) -> some View {
    modifier(LivePolling(model: model))
  }
}

private struct LivePolling<Value: Decodable & Hashable & Sendable>: ViewModifier {
  let model: LiveRead<Value>
  @Environment(ShellModel.self) private var shell

  // The shell's activity is read when each event happens, not when the view
  // last rendered, so a view that appears as the app becomes active polls.
  func body(content: Content) -> some View {
    content
      .onAppear { model.appeared(appActive: shell.isAppActive) }
      .onDisappear { model.disappeared() }
      .onChange(of: shell.isAppActive) { _, isActive in model.appActivityChanged(isActive) }
      .onChange(of: shell.liveRefreshes) { model.refreshIfLive() }
      .refreshable { await model.refresh() }
  }
}
