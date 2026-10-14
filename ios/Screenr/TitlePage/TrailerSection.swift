import ScreenrKit
import SwiftUI
import WebKit

// A title's trailer, collapsed behind Play trailer with a link to watch it
// on YouTube. Nothing loads from YouTube until Play trailer; then YouTube's
// embedded player opens inline, can play full screen, and stays open while
// the page reads again.
struct TrailerSection: View {
  let title: Title
  let trailer: Trailer
  let player: TrailerPlayer
  @Environment(\.trailerLoading) private var loading
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Trailer")
        .font(.title3.bold())
        .accessibilityAddTraits(.isHeader)
      if let page = player.page(for: trailer) {
        WebView(page)
          .webViewElementFullscreenBehavior(.enabled)
          .aspectRatio(16 / 9, contentMode: .fit)
          .frame(minHeight: 200)
          .clipShape(RoundedRectangle(cornerRadius: 12))
          .accessibilityLabel("\(title.name) trailer: \(trailer.name)")
          .accessibilityIdentifier("trailer-player")
          .onAppear { TrailerOrientation.shared.playerAppeared() }
          .onDisappear { TrailerOrientation.shared.playerDisappeared() }
        Text("If the trailer cannot play here, watch it on YouTube.")
          .font(.footnote)
          .foregroundStyle(.muted)
      }
      FlowLayout(spacing: 12) {
        if player.page(for: trailer) == nil {
          Button {
            player.play(trailer, loading: loading, openURL: openURL)
          } label: {
            Label("Play trailer", systemImage: "play.fill")
          }
          .buttonStyle(.feedAction)
        }
        if let watch = TrailerLinks.watch(trailer) {
          Link(destination: watch) {
            Label("Watch on YouTube", systemImage: "arrow.up.right.square")
          }
          .buttonStyle(.feedText)
        }
      }
    }
  }
}

// The open trailer's web page, kept by the title page so it survives reads.
// It belongs to one trailer; another trailer starts collapsed.
@Observable
final class TrailerPlayer {
  private var key: String?
  private var page: WebPage?

  func page(for trailer: Trailer) -> WebPage? {
    key == trailer.key ? page : nil
  }

  // Loads YouTube's embed, inline, which may then play full screen.
  func play(_ trailer: Trailer, loading: TrailerLoading, openURL: OpenURLAction) {
    guard let embed = TrailerLinks.embed(trailer) else { return }
    var configuration = WebPage.Configuration()
    configuration.mediaPlaybackBehavior = .allowsInlinePlayback
    let page = WebPage(
      configuration: configuration,
      navigationDecider: TrailerNavigationDecider(loading: loading, embed: embed, openURL: openURL)
    )
    page.load(URLRequest(url: embed))
    self.page = page
    key = trailer.key
  }
}

// Keeps the player on YouTube's embed: links out of it open outside the app,
// and the embed sends the site's origin as its referrer, as the web's does.
private struct TrailerNavigationDecider: WebPage.NavigationDeciding {
  let loading: TrailerLoading
  let embed: URL
  let openURL: OpenURLAction

  func decidePolicy(
    for action: WebPage.NavigationAction,
    preferences: inout WebPage.NavigationPreferences
  ) async -> WKNavigationActionPolicy {
    let isMainFrame = action.target?.isMainFrame ?? true
    switch loading.decide(action.request.url, isMainFrame: isMainFrame, embed: embed) {
    case .load:
      if isMainFrame { preferences.overrideReferrer = TrailerLinks.referrer }
      return .allow
    case .openOutside(let url):
      openURL(url)
      return .cancel
    case .cancel:
      return .cancel
    }
  }
}
