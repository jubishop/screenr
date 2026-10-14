import SwiftUI

// A full-screen message: a symbol, a title, an explanation, and any actions,
// centered, and scrolling at large text sizes. The symbol is decorative.
struct MessageView<Actions: View>: View {
  let title: String
  let systemImage: String
  let message: String
  @ViewBuilder let actions: () -> Actions

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        content
          .frame(maxWidth: .infinity, minHeight: proxy.size.height)
      }
    }
  }

  private var content: some View {
    VStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.largeTitle)
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
      Text(title)
        .font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
      Text(message)
      actions()
        .padding(.top, 8)
    }
    .multilineTextAlignment(.center)
    .padding(24)
  }
}

extension MessageView where Actions == EmptyView {
  init(title: String, systemImage: String, message: String) {
    self.init(title: title, systemImage: systemImage, message: message) { EmptyView() }
  }
}
