import ScreenrKit
import SwiftUI

@main
struct ScreenrApp: App {
  private let services: AppServices

  init() {
    let configuration: AppConfiguration
    do {
      configuration = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The build's Screenr settings are invalid: \(error)")
    }
    do {
      services = try AppServices(
        configuration: configuration,
        arguments: ProcessInfo.processInfo.arguments
      )
    } catch {
      fatalError("Screenr could not start its API client: \(error)")
    }
  }

  var body: some Scene {
    WindowGroup {
      WordmarkView()
        .screenrServices(services)
    }
  }
}
