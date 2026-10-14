import ScreenrKit
import SwiftUI

// A member screen's states: a spinner while it first loads, the error with
// Try again after a failed read, and the loaded screen. A feature screen keeps
// state that must outlive a failed read, such as a draft, outside this view,
// since a failed read replaces the content.
struct ScreenContent<Content: View>: View {
  let model: ScreenModel
  @ViewBuilder let content: (Screen) -> Content

  var body: some View {
    switch model.phase {
    case .loading:
      ProgressView("Loading")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let error):
      ReadFailureView(error: error) {
        await model.refresh()
      }
    case .loaded(let screen):
      switch screen.content {
      case .redirect:
        ProgressView("Loading")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      case .unknown:
        MessageView(
          title: "Update Screenr",
          systemImage: "arrow.down.app",
          message: "This page needs a newer version of Screenr."
        )
      default:
        content(screen)
      }
    }
  }
}

// A failed read: the reason and Try again. Pull-to-refresh also reads again.
struct ReadFailureView: View {
  let error: APIError
  let retry: () async -> Void

  var body: some View {
    MessageView(title: title, systemImage: symbol, message: error.readExplanation) {
      Button("Try again") {
        Task { await retry() }
      }
      .buttonStyle(.bordered)
    }
  }

  private var title: String {
    switch error.kind {
    case .notFound: "Not found"
    case .offline: "No connection"
    default: "Screenr didn't load"
    }
  }

  private var symbol: String {
    switch error.kind {
    case .notFound: "questionmark.square.dashed"
    case .offline: "wifi.slash"
    default: "exclamationmark.triangle"
    }
  }
}
