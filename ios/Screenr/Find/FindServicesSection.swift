import ScreenrKit
import SwiftUI

// My services, which keeps titles on the viewer's saved services or free in
// search results and both lists, and a way to change those services.
struct FindServicesSection: View {
  let find: FindModel
  let page: SearchScreen?
  @Environment(ShellModel.self) private var shell

  var body: some View {
    Section {
      Toggle("My services", isOn: myServices)
        // The saved services come with the screen, so the filter waits for it.
        .disabled(page == nil && find.serviceFilter == .allServices)
      // In its own row, since a subtitle or footer is too faint at its size.
      Text("Includes your saved services and free options.")
        .font(.footnote)
      if find.serviceFilter == .myServices, page == nil {
        Text(FindWording.servicesUnavailable)
          .font(.footnote)
      }
      if let notice = find.unknownViewingNotice(page) {
        Text(notice)
          .font(.footnote)
      }
      Button("Edit services") {
        shell.router.sheet = .settings
      }
    }
  }

  private var myServices: Binding<Bool> {
    Binding(
      get: { find.serviceFilter == .myServices },
      set: { find.serviceFilter = $0 ? .myServices : .allServices }
    )
  }
}
