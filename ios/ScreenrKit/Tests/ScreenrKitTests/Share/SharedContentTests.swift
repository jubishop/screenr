import Foundation
import ScreenrKit
import Testing
import UniformTypeIdentifiers

// What the share extension reads from another app's share: the first web
// link and the first text, as the server's resolve-title action takes them.
@MainActor
struct SharedContentTests {
  private func item(
    _ attachments: [NSItemProvider],
    contentText: String? = nil,
    title: String? = nil
  ) -> NSExtensionItem {
    let item = NSExtensionItem()
    item.attachments = attachments
    if let contentText { item.attributedContentText = NSAttributedString(string: contentText) }
    if let title { item.attributedTitle = NSAttributedString(string: title) }
    return item
  }

  private func link(_ text: String) throws -> NSItemProvider {
    NSItemProvider(object: try #require(URL(string: text)) as NSURL)
  }

  private func text(_ text: String) -> NSItemProvider {
    NSItemProvider(object: text as NSString)
  }

  @Test func readsAnAppsLinkAndMessage() async throws {
    let shared = await SharedContent.load(from: [
      item([
        text("Check out “Stranger Things” on Netflix"),
        try link("https://www.netflix.com/title/80057281"),
      ])
    ])

    #expect(
      shared
        == SharedContent(
          url: "https://www.netflix.com/title/80057281",
          text: "Check out “Stranger Things” on Netflix"
        )
    )
    #expect(!shared.isEmpty)
  }

  // Safari shares the page's link, with its title as the item's text.
  @Test func takesThePageTitleWhenNoAttachmentHasText() async throws {
    let shared = await SharedContent.load(from: [
      item(
        [try link("https://www.imdb.com/title/tt0111161/")],
        contentText: "The Shawshank Redemption (1994) - IMDb"
      )
    ])

    #expect(shared.url == "https://www.imdb.com/title/tt0111161/")
    #expect(shared.text == "The Shawshank Redemption (1994) - IMDb")

    let titled = await SharedContent.load(from: [
      item([try link("https://www.themoviedb.org/movie/550")], title: "Fight Club")
    ])
    #expect(titled.text == "Fight Club")
  }

  @Test func keepsTheFirstWebLinkAndText() async throws {
    let shared = await SharedContent.load(from: [
      item([try link("file:///private/var/note.txt"), text("  First  ")]),
      item([try link("https://www.imdb.com/title/tt0000101/"), text("Second")]),
      item([try link("https://www.themoviedb.org/tv/201")]),
    ])

    #expect(
      shared == SharedContent(url: "https://www.imdb.com/title/tt0000101/", text: "First")
    )
  }

  // A link inside the text reaches the server in the text, which reads it.
  @Test func leavesALinkInTextToTheServer() async {
    let shared = await SharedContent.load(from: [
      item([text("Watch this! https://www.imdb.com/title/tt0000101/")])
    ])

    #expect(shared.url.isEmpty)
    #expect(shared.text == "Watch this! https://www.imdb.com/title/tt0000101/")
  }

  @Test func cutsLongTextToWhatTheServerReads() {
    let shared = SharedContent(url: "", text: String(repeating: "a", count: 1_500))

    #expect(shared.text.count == SharedContent.maximumText)
    #expect(SharedContent(url: " ", text: "\n ").isEmpty)
  }

  @Test func findsNothingInAnEmptyShare() async {
    #expect(await SharedContent.load(from: []).isEmpty)
    #expect(await SharedContent.load(from: [item([])]).isEmpty)
  }
}
