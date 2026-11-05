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
  private enum Sheet {
    case open
    case closed
  }

  private var sheet = Sheet.open
  // The share, once its services have started.
  private var share: ShareModel?
  private var endings = ShareEndings.none
  private var resolving: Task<Void, Never>?

  override func viewDidLoad() {
    super.viewDidLoad()
    // iOS may run several shares in one process, which share one log writer.
    if let directory = LogFile.directory(appGroup: ShareExtension.configuration.appGroup) {
      _ = LogRouter.shared.file("share", in: directory)
    }
    let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
    let arguments = ShareExtension.arguments()
    // The share holds its services until it finishes, even after the sheet
    // closes, so nothing cancels this task.
    Task { [weak self] in
      do {
        try await ShareExtension.services.share(arguments: arguments) { share, services in
          guard let self else {
            share.close()
            return
          }
          self.show(share, services: services, items: items)
        }
      } catch {
        fatalError("Screenr could not start its API client: \(error)")
      }
    }
  }

  // The sheet went away without Close, as a swipe down takes it. iOS then
  // shows the host's share sheet again, so the request ends as cancelled.
  // Until a request ends, iOS keeps its controller in the extension's
  // process, even after the sheet has gone.
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    end(.cancelled)
  }

  private func show(_ share: ShareModel, services: AppServices, items: [NSExtensionItem]) {
    guard sheet == .open else {
      share.close()
      return
    }
    self.share = share
    endings = services.shareEndings
    let host = UIHostingController(
      rootView: ShareView(model: share) { [weak self] in self?.end(.completed) }
        .screenrServices(services)
    )
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
    resolving = Task { await share.resolve(await SharedContent.load(from: items)) }
  }

  // Ends the host's request, once. The share sends nothing more, and its
  // services stay until its requests in flight answer. A save among them
  // still finishes after the request ends, since the client keeps the
  // process running for a write.
  private func end(_ ending: ShareEnding) {
    guard sheet == .open else { return }
    sheet = .closed
    resolving?.cancel()
    share?.close()
    endings.report(ending)
    switch ending {
    case .completed:
      extensionContext?.completeRequest(returningItems: nil)
    case .cancelled:
      extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }
  }
}

// What every share in this process shares. iOS may run several shares in one
// process.
private enum ShareExtension {
  static let configuration: AppConfiguration = {
    do {
      return try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The extension's Screenr settings are invalid: \(error)")
    }
  }()

  static let telemetry = Telemetry.localOnly()

  // The client and image connections, which shares reuse while the member's
  // session stays the same, since the member may sign in again between them.
  static let services = ExtensionServices { arguments in
    try AppServices(
      configuration: configuration,
      arguments: arguments,
      observer: telemetry,
      host: .shareExtension
    )
  }

  // Screenr Dev's extension answers from the fixtures the app last launched
  // with, as UI tests and Simulator checks need.
  static func arguments() -> [String] {
    let arguments = ProcessInfo.processInfo.arguments
    return FixtureHandoff(configuration: configuration)?.arguments(arguments) ?? arguments
  }
}
