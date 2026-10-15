import ScreenrKit
import SwiftUI
import UIKit

// The share extension's entry point, which the system creates when a member
// picks Screenr in a share sheet. It reads what was shared and shows
// `ShareView`, which finds the title and offers Recommend and Want to watch.
// The extension shares the app's Keychain session through the app group, and
// logs to its own `share` file there, which the app's feedback form attaches.
// It starts no Sentry.
final class ShareViewController: UIViewController {
  private var resolving: Task<Void, Never>?

  override func viewDidLoad() {
    super.viewDidLoad()
    let configuration: AppConfiguration
    do {
      configuration = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The extension's Screenr settings are invalid: \(error)")
    }
    if let directory = LogFile.directory(appGroup: configuration.appGroup) {
      LogRouter.shared.add(LogFile(directory: directory, name: "share"))
    }
    // Screenr Dev's extension answers from the fixtures the app last
    // launched with, as UI tests and Simulator checks need.
    let arguments = ProcessInfo.processInfo.arguments
    let services: AppServices
    do {
      services = try AppServices(
        configuration: configuration,
        arguments: FixtureHandoff(configuration: configuration)?.arguments(arguments)
          ?? arguments,
        observer: Telemetry.localOnly(),
        host: .shareExtension
      )
    } catch {
      fatalError("Screenr could not start its API client: \(error)")
    }
    let model = ShareModel(api: services.api)
    let host = UIHostingController(
      rootView: ShareView(model: model) { [weak self] in self?.finish() }
        .screenrServices(services)
    )
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)

    let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    resolving = Task { await model.resolve(await SharedContent.load(from: items)) }
  }

  private func finish() {
    resolving?.cancel()
    extensionContext?.completeRequest(returningItems: nil)
  }
}
