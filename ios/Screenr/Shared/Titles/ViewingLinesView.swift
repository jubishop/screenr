import ScreenrKit
import SwiftUI

// Where a title streams in the US, under a title in a list: "On Netflix,
// Hulu" and "Free on Tubi TV", with the saved services marked, or why there
// is nothing to show.
struct ViewingLinesView: View {
  let viewing: TitleViewing
  let serviceIds: [String]
  // Whose saved services `serviceIds` are.
  var savedBy = SavedServicesOwner.viewer

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(viewing.lines(savedServices: serviceIds, savedBy: savedBy), id: \.self) { line in
        text(line)
          .accessibilityLabel(line.spokenText)
      }
    }
    .font(.footnote)
  }

  private func text(_ line: ViewingLine) -> Text {
    switch line {
    case .offers(let key, let services):
      var text = Text(ViewingLine.prefix(of: key))
      for (index, service) in services.enumerated() {
        let separator = index == 0 ? "" : ", "
        text = Text("\(text)\(separator)\(name(service))")
      }
      return text
    case .includesSavedServices:
      return Text(line.text).foregroundStyle(.tint)
    default:
      return Text(line.text).foregroundStyle(.muted)
    }
  }

  private func name(_ service: ListedService) -> Text {
    guard service.saved else { return Text(service.name) }
    return Text("\(service.name) \(Image(systemName: "checkmark.circle.fill"))")
      .bold()
      .foregroundStyle(.tint)
  }
}
