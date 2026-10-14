import Foundation
import ScreenrKit
import Testing

// The same cases as the web's member route tests, so a destination and the
// web's route agree on every path.
struct DestinationTests {
  @Test(
    arguments: [
      ("/", Destination.feed()),
      ("/?item=post&reply=answer", .feed(item: "post", reply: "answer")),
      ("/search", .search()),
      ("/search?q=Severance", .search(query: "Severance")),
      ("/search?q=+The%20Office+", .search(query: "The Office")),
      ("/search?tab=friends-recommend", .search(tab: .friendsRecommend)),
      ("/search?q=Lost&tab=friends-recommend", .search(query: "Lost", tab: .friendsRecommend)),
      ("/people", .people),
      ("/invites", .invites),
      ("/account?error=access_denied", .account),
      ("/watch-together", .watchTogether(with: [])),
      ("/watch-together?with=ben&with=&with=cam", .watchTogether(with: ["ben", "", "cam"])),
      ("/titles/movie/42", .title(id: "movie:42")),
      ("/titles/tv/7?item=post&reply=answer", .title(id: "tv:7", item: "post", reply: "answer")),
      ("/people/Alice", .profile(username: "Alice")),
      ("/people/a%20b", .profile(username: "a b")),
      ("/conversations/legacy?reply=old", .conversation(id: "legacy", reply: "old")),
      ("/join/AbC_123-xyz", .join(token: "AbC_123-xyz")),
      ("/?item=&reply=", .feed()),
      ("/search?q=%20%20", .search()),
      ("/search?tab=", .search()),
      ("/search?tab=suggestions", .search()),
      ("/search?tab=Friends-Recommend", .search()),
      ("/titles/movie/42?item=", .title(id: "movie:42")),
      ("/people/alice#friends", .profile(username: "alice")),
    ]
  )
  func namesEachScreenAndItsParameters(path: String, destination: Destination) {
    #expect(Destination(path: path) == destination)
  }

  @Test(
    arguments: [
      "/unknown", "/search/extra", "/watch-together/ben", "/titles/movie", "/titles/movie/42/extra",
      "/people/alice/friends", "/conversations", "/join", "/join/token/extra", "/login", "/setup",
      "/credits", "/privacy", "/api/screenr/screen", "/%E0%A4%A",
    ]
  )
  func rejectsUnknownPathsAndExtraSegments(path: String) {
    guard case .notFound = Destination(path: path) else {
      Issue.record("\(path) names a screen")
      return
    }
  }

  @Test func keepsAnUnknownPathWithoutItsQuery() {
    #expect(Destination(path: "/unknown?item=post") == .notFound(path: "/unknown"))
    #expect(Destination(path: "/%E0%A4%A") == .notFound(path: "/%E0%A4%A"))
  }

  @Test(
    arguments: [
      ("/?item=post&reply=answer&utm=x", "/?item=post&reply=answer"),
      ("/?item=", "/"),
      ("/search?item=post", "/search"),
      ("/search?item=post&q=The%20Office", "/search?q=The+Office"),
      ("/search?q=+Lost+", "/search?q=Lost"),
      ("/search?q=", "/search"),
      ("/search?tab=friends-recommend", "/search?tab=friends-recommend"),
      ("/search?q=Lost&tab=friends-recommend", "/search?tab=friends-recommend&q=Lost"),
      ("/search?tab=other&q=Lost", "/search?q=Lost"),
      ("/?tab=friends-recommend", "/"),
      ("/?q=Lost", "/"),
      ("/account?error=access_denied", "/account"),
      ("/people/alice?item=post", "/people/alice"),
      ("/people/a%20b", "/people/a%20b"),
      ("/titles/movie/42?reply=answer&item=post", "/titles/movie/42?item=post&reply=answer"),
      ("/titles/movie/1%3Fitem%3Dx", "/titles/movie/1%3Fitem%3Dx"),
      ("/watch-together?with=ben&with=&x=1", "/watch-together?with=ben&with="),
      ("/conversations/legacy?reply=old&item=x", "/conversations/legacy?reply=old"),
      ("/unknown?item=post", "/unknown"),
      ("/join/AbC_123-xyz", "/join/AbC_123-xyz"),
      ("/people/%2F%2Fevil.example", "/people/%2F%2Fevil.example"),
      ("/search?q=caf%C3%A9%20%26%20tea", "/search?q=caf%C3%A9+%26+tea"),
      ("/people/it's(me)!", "/people/it's(me)!"),
    ]
  )
  func keepsOnlyEachScreensParametersAndRoundTrips(path: String, canonical: String) {
    let destination = Destination(path: path)
    #expect(destination.path == canonical)
    #expect(Destination(path: canonical) == destination)
  }

  @Test(
    arguments: [
      Destination.feed(), .feed(item: "post"), .feed(item: "post", reply: "answer"),
      .search(), .search(query: "The Office"), .search(query: "Lost", tab: .friendsRecommend),
      .people, .invites, .account, .watchTogether(with: ["ben", "cam"]),
      .title(id: "movie:42"), .title(id: "tv:7", item: "post", reply: "answer"),
      .profile(username: "a b"), .conversation(id: "legacy", reply: "old"),
      .join(token: "AbC_123-xyz"), .notFound(path: "/unknown"),
    ]
  )
  func convertsEveryDestinationToAPathAndBack(destination: Destination) {
    #expect(Destination(path: destination.path) == destination)
  }

  @Test(
    arguments: [
      ("https://screenr.club/", Destination.feed()),
      ("https://screenr.club", .feed()),
      ("https://screenr.club/?item=post&reply=answer", .feed(item: "post", reply: "answer")),
      ("https://screenr.club/titles/tv/201?item=post", .title(id: "tv:201", item: "post")),
      ("https://Screenr.Club/people/ben#top", .profile(username: "ben")),
      ("https://screenr.club/search?q=Lost", .search(query: "Lost")),
      ("https://screenr.club/join/AbC_123-xyz", .join(token: "AbC_123-xyz")),
      ("https://screenr.club/conversations/legacy", .conversation(id: "legacy")),
      ("https://screenr.club/unknown", .notFound(path: "/unknown")),
      (
        "screenr-dev://titles/movie/42?item=post&reply=answer",
        .title(
          id: "movie:42",
          item: "post",
          reply: "answer"
        )
      ),
      ("screenr-dev:///people/ben", .profile(username: "ben")),
      ("screenr-dev://people", .people),
      ("screenr-dev://", .feed()),
      ("screenr-dev://?item=post", .feed(item: "post")),
      ("screenr-dev://watch-together?with=ben", .watchTogether(with: ["ben"])),
      ("screenr-dev://join/AbC_123-xyz", .join(token: "AbC_123-xyz")),
    ]
  )
  func opensUniversalLinksAndTheDevScheme(link: String, destination: Destination) throws {
    #expect(Destination(url: try #require(URL(string: link))) == destination)
  }

  @Test(
    arguments: [
      "https://example.com/titles/tv/201", "http://screenr.club/people/ben",
      "https://screenr.club.example.com/people", "mailto:ben@example.com", "screenr://people",
    ]
  )
  func ignoresOtherLinks(link: String) throws {
    #expect(Destination(url: try #require(URL(string: link))) == nil)
  }

  @Test func sharesScreenrClubLinks() {
    #expect(
      Destination.title(id: "tv:201", item: "post").shareURL.absoluteString
        == "https://screenr.club/titles/tv/201?item=post"
    )
    #expect(Destination.feed().shareURL.absoluteString == "https://screenr.club/")
    #expect(
      Destination.profile(username: "a b").shareURL.absoluteString
        == "https://screenr.club/people/a%20b"
    )
    #expect(
      Destination.search(query: "The Office").shareURL.absoluteString
        == "https://screenr.club/search?q=The+Office"
    )
  }

  @Test(
    arguments: [
      (Destination.feed(), "Your circle"), (.feed(item: "post"), "Your circle"),
      (.search(query: "Lost"), "Find a title"), (.people, "Friends"),
      (.invites, "Invite friends"), (.account, "Settings"),
      (.watchTogether(with: ["ben"]), "Watch together"),
      (.conversation(id: "legacy"), "Conversation"),
      (.notFound(path: "/unknown"), "Page not found"),
      (.title(id: "movie:42"), "Movie"), (.title(id: "tv:7"), "TV show"),
      (.profile(username: "a b"), "@a b"), (.join(token: "token"), "Invitation"),
    ]
  )
  func namesEachPageBeforeItLoads(destination: Destination, name: String) {
    #expect(destination.pageName(for: nil) == name)
  }

  @Test func namesTitlesAndPeopleFromTheirScreens() throws {
    let title = try screen("screen/title/movie")
    let profile = try screen("screen/profile/friend")
    guard case .title(let page) = title.content, case .profile(let person) = profile.content
    else {
      Issue.record("The fixtures are not a title and a profile")
      return
    }

    #expect(Destination.title(id: page.title.id).pageName(for: title) == page.title.name)
    #expect(
      Destination.profile(username: person.profile.person.username).pageName(for: profile)
        == person.profile.person.displayName
    )
    // Another screen's data never names the page.
    #expect(Destination.title(id: "tv:7").pageName(for: profile) == "TV show")
    #expect(Destination.profile(username: "alice").pageName(for: title) == "@alice")
  }

  @Test func asksTheScreenAPIForEachMemberScreen() {
    #expect(Destination.title(id: "tv:7", item: "post").screenPath == "/titles/tv/7?item=post")
    #expect(Destination.feed().screenPath == "/")
    #expect(Destination.join(token: "token").screenPath == nil)
    #expect(Destination.notFound(path: "/unknown").screenPath == nil)
  }
}
