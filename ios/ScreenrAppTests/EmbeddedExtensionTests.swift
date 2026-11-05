import Foundation
import ScreenrKit
import Testing

// The extensions the app embeds, as built. Each reads its Screenr settings
// from its own Info.plist with AppConfiguration and stops when one is
// missing or invalid, so a setting left out of an extension would end it
// the first time iOS starts it.
struct EmbeddedExtensionTests {
  struct Embedded: Sendable, CustomTestStringConvertible {
    let name: String
    let suffix: String
    let point: String
    let principalClass: String

    var testDescription: String { name }
  }

  static let extensions = [
    Embedded(
      name: "ScreenrShare",
      suffix: "Share",
      point: "com.apple.share-services",
      principalClass: "ScreenrShare.ShareViewController"
    ),
    Embedded(
      name: "ScreenrNotificationService",
      suffix: "NotificationService",
      point: "com.apple.usernotifications.service",
      principalClass: "ScreenrNotificationService.NotificationService"
    ),
  ]

  @Test(arguments: extensions)
  func readsTheAppsSettings(_ embedded: Embedded) throws {
    let app = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    let plugIns = try #require(Bundle.main.builtInPlugInsURL)
    let bundle = try #require(Bundle(url: plugIns.appending(path: "\(embedded.name).appex")))
    let info = try #require(bundle.infoDictionary)

    #expect(try AppConfiguration(infoDictionary: info) == app)
    #expect(bundle.bundleIdentifier == "\(Bundle.main.bundleIdentifier ?? "").\(embedded.suffix)")
    let attributes = try #require(info["NSExtension"] as? [String: Any])
    #expect(attributes["NSExtensionPointIdentifier"] as? String == embedded.point)
    #expect(attributes["NSExtensionPrincipalClass"] as? String == embedded.principalClass)
  }
}
