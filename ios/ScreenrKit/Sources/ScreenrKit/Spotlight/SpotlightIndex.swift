import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

// The device's Spotlight index of the app's titles. Each item's identifier is
// the title ID, which a selected result hands back to the app. `thumbnail`
// returns a poster's image data when the app already has it, such as in the
// image cache, so indexing never downloads anything.
public struct SpotlightIndex: TitleIndex {
  public static let domain = "titles"

  private let thumbnail: @Sendable (String) -> Data?

  public init(thumbnail: @escaping @Sendable (String) -> Data? = { _ in nil }) {
    self.thumbnail = thumbnail
  }

  public func index(_ titles: [TitleSummary]) async throws {
    try await CSSearchableIndex.default().indexSearchableItems(titles.map(item(for:)))
  }

  public func remove(_ ids: [String]) async throws {
    try await CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: ids)
  }

  public func removeAll() async throws {
    try await CSSearchableIndex.default().deleteAllSearchableItems()
  }

  // A title's result: its name, kind and year, and poster.
  func item(for title: TitleSummary) -> CSSearchableItem {
    let attributes = CSSearchableItemAttributeSet(contentType: .content)
    attributes.title = title.name
    attributes.displayName = title.name
    attributes.contentDescription = title.details
    if let path = title.posterPath {
      attributes.thumbnailData = thumbnail(path)
    }
    let item = CSSearchableItem(
      uniqueIdentifier: title.id,
      domainIdentifier: Self.domain,
      attributeSet: attributes
    )
    // Items otherwise expire after a month. The member's titles stay until
    // the session ends.
    item.expirationDate = .distantFuture
    return item
  }
}
