import Foundation
import UniformTypeIdentifiers

// What another app shared to the share extension: its first web link and its
// first text, each empty when the share has none. The server's resolve-title
// action reads both, and finds a link inside the text too.
public struct SharedContent: Hashable, Sendable {
  // The most text the server reads.
  public static let maximumText = 1_000

  public let url: String
  public let text: String

  public init(url: String = "", text: String = "") {
    self.url = url.trimmingCharacters(in: .whitespacesAndNewlines)
    self.text = String(
      text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maximumText)
    )
  }

  public var isEmpty: Bool { url.isEmpty && text.isEmpty }

  // Reads the share sheet's items. An app's message or a page's title comes
  // from a text attachment, or else from the item's own text or title, which
  // is where Safari puts a page's title.
  public static func load(from items: [NSExtensionItem]) async -> SharedContent {
    var url = ""
    var text = ""
    for item in items {
      for provider in item.attachments ?? [] {
        if url.isEmpty, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
          let link = await webLink(from: provider)
        {
          url = link
        } else if text.isEmpty,
          provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
        {
          text = await plainText(from: provider)
        }
      }
    }
    if text.isEmpty {
      let itemTexts = items.flatMap {
        [$0.attributedContentText?.string, $0.attributedTitle?.string]
      }
      text = itemTexts.compactMap { $0 }.first { !$0.isEmpty } ?? ""
    }
    return SharedContent(url: url, text: text)
  }

  private static func webLink(from provider: NSItemProvider) async -> String? {
    let link: URL? = await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: URL.self) { url, error in
        if let error { Log.share.warning("A shared link was unreadable", .error(error)) }
        continuation.resume(returning: url)
      }
    }
    guard let link, let scheme = link.scheme?.lowercased(), scheme == "https" || scheme == "http"
    else { return nil }
    return link.absoluteString
  }

  private static func plainText(from provider: NSItemProvider) async -> String {
    await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: String.self) { text, error in
        if let error { Log.share.warning("Shared text was unreadable", .error(error)) }
        continuation.resume(returning: text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
      }
    }
  }
}

extension Log {
  // The share extension's own lines.
  static let share = Log(LogCategory("share"))
}
