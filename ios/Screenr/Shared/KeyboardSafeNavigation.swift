import ScreenrKit
import SwiftUI

extension View {
  // Ends text editing whenever `path`, a navigation stack's path, shows a
  // new screen, before the transition starts, whether a link or the router
  // changed it. Otherwise editing ends inside a Core Animation commit as the
  // transition starts or the replaced screen goes, and UIKit brings the
  // keyboard back as a later pop animates; for a field inside a SwiftUI
  // scroll view, such as a feed's composer, that can deadlock the app, as a
  // closing sheet's keyboard can (see `keyboardSafeSheet(item:content:)`).
  // A pop, which shows a screen that was already there, keeps editing as it
  // is. The draft stays, and the keyboard returns when the reader taps the
  // field.
  func keyboardSafeNavigation(_ path: [Destination]) -> some View {
    onChange(of: path) { old, new in
      if new.count < old.count, old.starts(with: new) { return }
      UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder),
        to: nil,
        from: nil,
        for: nil
      )
    }
  }
}
