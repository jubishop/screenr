import SwiftUI

extension View {
  // A sheet that ends text editing before it opens; every sheet in the app
  // uses it. When a sheet closes, UIKit brings back the keyboard of a field
  // that was editing as it opened. For a field inside a SwiftUI scroll view,
  // such as a feed's composer, that can deadlock the app: the keyboard's
  // layout and SwiftUI's background renderer, animating the closing sheet,
  // each wait for a lock the other holds. The draft stays, and the keyboard
  // returns when the reader taps the field.
  func keyboardSafeSheet<Item: Identifiable, Sheet: View>(
    item: Binding<Item?>,
    @ViewBuilder content: @escaping (Item) -> Sheet
  ) -> some View {
    modifier(KeyboardSafeSheet(item: item, sheet: content))
  }
}

private struct KeyboardSafeSheet<Item: Identifiable, Sheet: View>: ViewModifier {
  @Binding var item: Item?
  let sheet: (Item) -> Sheet
  // The item the sheet may show, set only once editing has ended, so the
  // sheet opens in the next update.
  @State private var ready: Item.ID?

  func body(content: Content) -> some View {
    content
      .sheet(
        item: Binding(
          get: {
            guard let item, item.id == ready else { return nil }
            return item
          },
          set: { item = $0 }
        ),
        content: sheet
      )
      .onChange(of: item?.id, initial: true) { _, id in
        if id != nil {
          UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
          )
        }
        ready = id
      }
  }
}
