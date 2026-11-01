import ScreenrKit
import SwiftUI

// The At home and In theaters switch on Want to watch pages and Watch
// together. Each mode is its own destination with its own read, so choosing
// one shows that mode in place of this screen, and Back leaves the list.
struct ListModePicker: View {
  // The screen the switch is on.
  let destination: Destination
  @Environment(ShellModel.self) private var shell

  var body: some View {
    Picker("List", selection: mode) {
      ForEach(Destination.ListMode.allCases) { mode in
        Text(mode.label).tag(mode)
      }
    }
    .pickerStyle(.segmented)
    // Segments as wide as their titles, which a full-width control clips.
    .fixedSize()
  }

  private var mode: Binding<Destination.ListMode> {
    Binding {
      destination.listMode ?? .atHome
    } set: { mode in
      // The other mode takes this screen's place without a push's slide.
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        shell.router.replace(destination, with: destination.inMode(mode))
      }
    }
  }
}
