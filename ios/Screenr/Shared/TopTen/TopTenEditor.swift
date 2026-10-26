import ScreenrKit
import SwiftUI

// A profile whose Edit, on the member's own profile, opens the top 10 editor
// sheet. The sheet sits outside the profile's content, so a failed read
// beneath it leaves it open.
struct ProfileWithTopTenEditor: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api
  @State private var editor: TopTenEditorModel?

  var body: some View {
    ProfileView(model: model, destination: destination) {
      editor = TopTenEditorModel(entries: TopTenEditorSheet.topTen(in: model) ?? [], api: api) {
        await model.refresh()
      }
    }
    .sheet(item: $editor) { editor in
      TopTenEditorSheet(editor: editor, screen: model)
    }
  }
}

// The member's top 10 as a system list: drag a row's handle to give it a new
// rank, and swipe a row to remove it, which keeps its Recommend. The profile's
// reads beneath keep the list current.
private struct TopTenEditorSheet: View {
  let editor: TopTenEditorModel
  let screen: ScreenModel

  var body: some View {
    NavigationStack {
      TopTenEditorList(
        editor: editor,
        entries: editor.entries,
        failure: editor.failure,
        write: editor.write
      )
      .ignoresSafeArea(.container, edges: .bottom)
      .navigationTitle("Edit top 10")
      .toolbarTitleDisplayMode(.inline)
      .toolbar { CloseButton() }
    }
    .onChange(of: Self.topTen(in: screen)) { _, entries in
      if let entries { editor.reconcile(with: entries) }
    }
    .onChange(of: editor.failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
  }

  static func topTen(in screen: ScreenModel) -> [TopTenEntry]? {
    guard case .profile(let page) = screen.value?.content else { return nil }
    return page.topTen
  }
}

// One entry: its rank, poster, and name. Besides dragging its handle,
// VoiceOver can move it one place with Move up and Move down, as the web's
// controls do; `move` takes the new rank.
struct TopTenEditorRow: View {
  let entry: TopTenEntry
  // The number of entries in the list.
  let count: Int
  let move: (_ rank: Int) -> Void

  var body: some View {
    HStack(spacing: 12) {
      Text("#\(entry.rank)")
        .monospacedDigit()
        .foregroundStyle(.muted)
      PosterImage(path: entry.posterPath, name: entry.name, width: 40)
      Text(entry.name)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("#\(entry.rank) \(entry.name)")
    .accessibilityActions {
      if entry.rank > 1 {
        Button("Move up") { move(entry.rank - 1) }
      }
      if entry.rank < count {
        Button("Move down") { move(entry.rank + 1) }
      }
    }
  }
}
