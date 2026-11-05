import ScreenrKit
import SwiftUI

extension View {
  // Ends text editing as `path`, a navigation stack's path, grows, before
  // the push starts, whether a link or the router pushed. Otherwise UIKit
  // ends it inside a Core Animation commit as the push starts, and brings the
  // keyboard back as the pop animates; for a field inside a SwiftUI scroll
  // view, such as a feed's composer, that can deadlock the app, as a closing
  // sheet's keyboard can (see `keyboardSafeSheet(item:content:)`). The draft
  // stays, and the keyboard returns when the reader taps the field.
  func keyboardSafeNavigation(_ path: [Destination]) -> some View {
    onChange(of: path.count) { old, new in
      guard new > old else { return }
      UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder),
        to: nil,
        from: nil,
        for: nil
      )
    }
  }
}
