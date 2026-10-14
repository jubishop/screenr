import Foundation
import ScreenrKit
import Testing

@MainActor
struct RouterTests {
  @Test func startsAtTheFriendsFeed() {
    let router = Router()

    #expect(router.selectedTab == .circle)
    #expect(router.root(of: .circle) == .feed())
    #expect(router.root(of: .friends) == .people)
    #expect(router.root(of: .find) == .search())
    // You shows the viewer's profile once the shell knows who they are.
    #expect(router.root(of: .you) == nil)
    router.viewerUsername = "alice"
    #expect(router.root(of: .you) == .profile(username: "alice"))
  }

  @Test func opensTabScreensAtTheirTabsRoots() throws {
    let router = Router()
    router.open(.title(id: "tv:201"))

    router.open(.feed())
    #expect(router.selectedTab == .circle)
    #expect(router.paths[.circle, default: []].isEmpty)

    router.open(.search(query: "Lost", tab: .friendsRecommend))
    #expect(router.selectedTab == .find)
    #expect(router.root(of: .find) == .search())
    #expect(router.findSearch == .search(query: "Lost", tab: .friendsRecommend))

    router.open(.people)
    #expect(router.selectedTab == .friends)
    #expect(router.paths[.friends, default: []].isEmpty)
  }

  // Tab roots keep their destinations, so their screens persist.
  @Test func opensAFeedEntryAboveCirclesRoot() {
    let router = Router()
    router.open(.title(id: "tv:201"))

    router.open(.feed(item: "post", reply: "answer"))

    #expect(router.selectedTab == .circle)
    #expect(router.root(of: .circle) == .feed())
    #expect(router.paths[.circle] == [.feed(item: "post", reply: "answer")])
  }

  @Test func opensFriendsPagesInFriends() {
    let router = Router()

    router.open(.watchTogether(with: ["ben"]))
    #expect(router.selectedTab == .friends)
    #expect(router.paths[.friends] == [.watchTogether(with: ["ben"])])

    router.open(.invites)
    #expect(router.paths[.friends] == [.invites])
  }

  @Test func opensAccountAsSettingsOverYou() {
    let router = Router()
    router.viewerUsername = "alice"

    router.open(.account)

    #expect(router.selectedTab == .you)
    #expect(router.sheet == .settings)
  }

  @Test func pushesOtherScreensOnTheCurrentTab() {
    let router = Router()
    router.selectedTab = .friends
    router.sheet = .notifications

    router.open(.profile(username: "ben"))
    router.open(.title(id: "tv:201", item: "post"))
    router.open(.title(id: "tv:201", item: "post"))
    router.open(.conversation(id: "legacy"))
    router.open(.notFound(path: "/unknown"))

    #expect(router.selectedTab == .friends)
    #expect(
      router.paths[.friends] == [
        .profile(username: "ben"), .title(id: "tv:201", item: "post"),
        .conversation(id: "legacy"), .notFound(path: "/unknown"),
      ]
    )
    // Opening a link closes the sheet over it.
    #expect(router.sheet == nil)
  }

  @Test func opensTheViewersOwnProfileAsYou() {
    let router = Router()
    router.viewerUsername = "alice"
    router.open(.title(id: "tv:201"))
    router.selectedTab = .you
    router.open(.title(id: "movie:101"))

    router.open(.profile(username: "Alice"))

    #expect(router.selectedTab == .you)
    #expect(router.paths[.you, default: []].isEmpty)
  }

  // Sign-in and setup send the token from the app's pending invitation.
  @Test func keepsAnInvitationForSignup() {
    let invitation = PendingInvitation()
    let router = Router(invitation: invitation)

    router.open(.join(token: "AbC_123-xyz"))
    router.reset()

    #expect(invitation.token == "AbC_123-xyz")
    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })
  }

  @Test func opensScreenrLinksAndIgnoresOthers() throws {
    let router = Router()

    #expect(router.open(try #require(URL(string: "screenr-dev://titles/tv/201?item=post"))))
    #expect(!router.open(try #require(URL(string: "https://example.com/titles/tv/202"))))

    #expect(router.paths[.circle] == [.title(id: "tv:201", item: "post")])
  }

  @Test func bindsEachTabsStack() {
    let router = Router()

    router[stack: .find] = [.title(id: "tv:201")]

    #expect(router.paths[.find] == [.title(id: "tv:201")])
    #expect(router[stack: .find] == [.title(id: "tv:201")])
    #expect(router[stack: .you].isEmpty)
  }

  @Test func forgetsTheMembersPlaceWhenTheySignOut() {
    let router = Router()
    router.viewerUsername = "alice"
    router.open(.feed(item: "post"))
    router.open(.title(id: "tv:201"))
    router.open(.search(query: "Lost"))
    router.sheet = .notifications

    router.reset()

    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })
    #expect(router.findSearch == .search())
    #expect(router.root(of: .you) == nil)
    #expect(router.sheet == nil)
  }
}
