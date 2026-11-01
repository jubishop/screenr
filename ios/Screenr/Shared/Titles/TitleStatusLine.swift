import ScreenrKit
import SwiftUI

// A title's US release status, such as "In theaters · Digital Nov 20", with
// TMDB's user score beside it, the TMDB logo and a percentage such as 73%, in
// title lists and atop Where to watch. The score moves beneath the status
// when the line is too narrow for both. Nothing shows without a status label
// or a score.
struct TitleStatusLine: View {
  let release: TitleRelease?
  let score: TMDBScore?
  var style = Font.TextStyle.footnote

  var body: some View {
    let text = release?.text
    if text != nil || score != nil {
      FlowLayout(spacing: 12) {
        if let text {
          Text(text)
            .font(.system(style, weight: .semibold))
        }
        if let score {
          TMDBScoreBadge(score: score, style: style)
        }
      }
    }
  }
}

// The unmodified TMDB logo, about as tall as the capitals beside it, then the
// score.
private struct TMDBScoreBadge: View {
  let score: TMDBScore
  let style: Font.TextStyle
  @ScaledMetric private var logoHeight: CGFloat

  init(score: TMDBScore, style: Font.TextStyle) {
    self.score = score
    self.style = style
    _logoHeight = ScaledMetric(wrappedValue: style == .subheadline ? 10.5 : 9, relativeTo: style)
  }

  var body: some View {
    HStack(spacing: 5) {
      Image("TMDBLogo", label: Text("TMDB"))
        .resizable()
        .scaledToFit()
        .frame(height: logoHeight)
      Text(score.text)
        .font(.system(style, weight: .semibold))
    }
  }
}
