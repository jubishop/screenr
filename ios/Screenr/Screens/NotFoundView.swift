import SwiftUI

// A link that names no Screenr screen.
struct NotFoundView: View {
  var body: some View {
    MessageView(
      title: "Page not found",
      systemImage: "questionmark.square.dashed",
      message: "This link doesn't open a page in Screenr."
    )
  }
}
