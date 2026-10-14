import ScreenrKit
import SwiftUI

// Account settings, `/account`, in the Settings sheet that the You tab's gear
// opens.
struct AccountView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .account(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: ["\(page.serviceIds.count) streaming services"]
        ) {
          SignOutButton()
        }
      }
    }
  }
}
