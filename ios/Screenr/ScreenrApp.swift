import ScreenrKit
import SwiftUI

@main
struct ScreenrApp: App {
  private let configuration: AppConfiguration

  init() {
    do {
      configuration = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The build's Screenr settings are invalid: \(error)")
    }
  }

  var body: some Scene {
    WindowGroup {
      WordmarkView()
    }
  }
}
