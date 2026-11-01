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

    router.open(.watchTogether(with: ["ben"], mode: .inTheaters))
    #expect(router.paths[.friends] == [.watchTogether(with: ["ben"], mode: .inTheaters)])
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
    router.viewerUsername = "alice"
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

  // The viewer's own Want to watch page opens above You's root, as their
  // profile's link opens it; another member's opens on the current tab.
  @Test func opensTheViewersOwnWantToWatchPageInYou() {
    let router = Router()
    router.viewerUsername = "alice"
    router.selectedTab = .friends
    router.open(.title(id: "tv:201"))

    router.open(.wantToWatch(username: "Alice"))
    #expect(router.selectedTab == .you)
    #expect(router.paths[.you] == [.wantToWatch(username: "Alice")])
    #expect(router.paths[.friends] == [.title(id: "tv:201")])

    router.open(.wantToWatch(username: "ben"))
    #expect(router.selectedTab == .you)
    #expect(router.paths[.you] == [.wantToWatch(username: "Alice"), .wantToWatch(username: "ben")])

    router.open(.wantToWatch(username: "alice", mode: .inTheaters))
    #expect(router.paths[.you] == [.wantToWatch(username: "alice", mode: .inTheaters)])
  }

  // Switching a list's mode shows the other mode in its place on the current
  // tab, so Back leaves the list rather than returning to the other mode.
  @Test func replacesTheScreenOnTopOfTheCurrentTab() {
    let router = Router()
    let atHome = Destination.watchTogether(with: ["ben"])
    let inTheaters = Destination.watchTogether(with: ["ben"], mode: .inTheaters)
    router.selectedTab = .friends
    router.paths[.friends] = [.profile(username: "ben"), atHome]
    router.paths[.circle] = [atHome]

    router.replace(atHome, with: inTheaters)
    #expect(router.paths[.friends] == [.profile(username: "ben"), inTheaters])
    #expect(router.paths[.circle] == [atHome])

    // A screen beneath the top stays.
    router.replace(.profile(username: "ben"), with: .profile(username: "cam"))
    #expect(router.paths[.friends] == [.profile(username: "ben"), inTheaters])

    // So does a tab root.
    router.selectedTab = .find
    router.replace(.search(), with: inTheaters)
    #expect(router.paths[.find, default: []].isEmpty)
  }

  // A link that names a member and arrives before a screen names the viewer,
  // such as at launch, waits for them, so the viewer's own pages still open
  // in You, in the mode the link names.
  @Test(arguments: [
    (Destination.profile(username: "Alice"), [Destination]()),
    (.wantToWatch(username: "Alice"), [.wantToWatch(username: "Alice")]),
    (
      .wantToWatch(username: "Alice", mode: .inTheaters),
      [.wantToWatch(username: "Alice", mode: .inTheaters)]
    ),
  ])
  func opensTheViewersOwnPagesInYouOnceTheViewerIsKnown(
    _ link: Destination,
    above path: [Destination]
  ) {
    let router = Router()

    router.open(link)
    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })

    router.viewerUsername = "alice"
    #expect(router.selectedTab == .you)
    #expect(router.paths[.you] == path)
  }

  // Another member's pages wait too, then open on the current tab.
  @Test(arguments: [
    Destination.profile(username: "ben"), .wantToWatch(username: "ben"),
    .wantToWatch(username: "ben", mode: .inTheaters),
  ])
  func opensAnotherMembersPagesOnTheCurrentTabOnceTheViewerIsKnown(_ link: Destination) {
    let router = Router()
    router.selectedTab = .friends

    router.open(link)
    router.viewerUsername = "alice"

    #expect(router.selectedTab == .friends)
    #expect(router.paths[.friends] == [link])
  }

  // The member followed the later link last, so the earlier one no longer
  // waits.
  @Test func letsALaterLinkReplaceOneWaitingForTheViewer() {
    let router = Router()

    router.open(.profile(username: "alice"))
    router.open(.title(id: "tv:201"))
    router.viewerUsername = "alice"

    #expect(router.selectedTab == .circle)
    #expect(router.paths == [.circle: [.title(id: "tv:201")]])
  }

  // Sign-in and setup send the token from the app's pending invitation.
  @Test func keepsAnInvitationForSignup() {
    let invitation = PendingInvitation()
    let router = Router(invitation: invitation)

    router.open(.join(token: "AbC_123-xyz"))
    router.sessionEnded(.signedOut)

    #expect(invitation.token == "AbC_123-xyz")
    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })
  }

  // A member who already has a profile lands in Circle from an invitation
  // link, as on the web, unless a later link takes them elsewhere.
  @Test func opensCircleForAnInvitationUntilALaterLink() {
    let router = Router()
    router.selectedTab = .friends
    router.open(.title(id: "tv:201"))
    router.sheet = .notifications

    router.open(.join(token: "AbC_123-xyz"))
    #expect(router.selectedTab == .circle)
    #expect(router.paths[.circle] == [])
    #expect(router.sheet == nil)

    router.open(.title(id: "tv:202"))
    #expect(router.paths[.circle] == [.title(id: "tv:202")])
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

    router.sessionEnded(.signedOut)

    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })
    #expect(router.findSearch == .search())
    #expect(router.root(of: .you) == nil)
    #expect(router.sheet == nil)
  }

  // A member whose session expired may have just followed a link into the
  // 401, so it opens again for the next sign-in. The rest of their place is
  // still forgotten.
  @Test func keepsALinkWhoseScreenHasNotLoadedWhenTheSessionExpires() {
    let router = Router()
    router.viewerUsername = "alice"
    router.open(.search(query: "Lost"))
    router.selectedTab = .friends
    router.open(.title(id: "tv:201"))
    // The screen that showed before the link does not show it.
    router.screenLoaded(.people)

    router.sessionEnded(.expired)

    #expect(router.selectedTab == .circle)
    #expect(router.paths == [.circle: [.title(id: "tv:201")]])
    #expect(router.findSearch == .search())
    #expect(router.root(of: .you) == nil)
  }

  // A link to the viewer's own page that the session expired before showing
  // opens in You again once the next sign-in names the viewer.
  @Test(arguments: [
    (Destination.profile(username: "Alice"), [Destination]()),
    (.wantToWatch(username: "Alice"), [.wantToWatch(username: "Alice")]),
    (
      .wantToWatch(username: "Alice", mode: .inTheaters),
      [.wantToWatch(username: "Alice", mode: .inTheaters)]
    ),
  ])
  func reopensTheViewersOwnPagesInYouAfterTheSessionExpires(
    _ link: Destination,
    above path: [Destination]
  ) {
    let router = Router()
    router.viewerUsername = "alice"
    router.open(link)

    router.sessionEnded(.expired)
    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })

    router.viewerUsername = "alice"
    #expect(router.selectedTab == .you)
    #expect(router.paths[.you] == path)
  }

  // The account check at launch can end an expired session before any screen
  // names the viewer, and a link waiting for them waits for the next sign-in.
  @Test func keepsALinkWaitingForTheViewerWhenTheSessionExpires() {
    let router = Router()
    router.open(.wantToWatch(username: "alice"))

    router.sessionEnded(.expired)
    router.viewerUsername = "alice"

    #expect(router.selectedTab == .you)
    #expect(router.paths[.you] == [.wantToWatch(username: "alice")])
  }

  @Test func forgetsALinkOnceItsScreenLoads() {
    let router = Router()
    router.open(.title(id: "tv:201"))

    router.screenLoaded(.title(id: "tv:201"))
    router.sessionEnded(.expired)

    #expect(router.paths.values.allSatisfy { $0.isEmpty })
  }

  // Signing out or deleting the account leaves nothing for the next member,
  // even a link still waiting for the viewer.
  @Test(arguments: [SessionStore.Ending.signedOut, .accountDeleted])
  func forgetsALinkWhenTheMemberLeaves(_ ending: SessionStore.Ending) {
    let router = Router()
    router.open(.title(id: "tv:201"))
    router.open(.profile(username: "alice"))

    router.sessionEnded(ending)
    router.viewerUsername = "alice"

    #expect(router.selectedTab == .circle)
    #expect(router.paths.values.allSatisfy { $0.isEmpty })
  }

  // A link waits for the screen that shows it, such as Find's root for a
  // search, and a link that names no screen waits for any screen.
  @Test(arguments: [
    (Destination.search(query: "Lost", tab: .friendsRecommend), Destination.search()),
    (.profile(username: "Alice"), .profile(username: "alice")),
    (.account, .account),
    (.feed(item: "post"), .feed(item: "post")),
    (.notFound(path: "/nothing/here"), .people),
  ])
  func waitsForTheScreenThatShowsALink(_ link: Destination, shownBy screen: Destination) {
    let kept = Router()
    let shown = Router()
    for router in [kept, shown] {
      router.viewerUsername = "alice"
      router.open(link)
    }

    shown.screenLoaded(screen)
    kept.sessionEnded(.expired)
    shown.sessionEnded(.expired)

    // The kept link opens as it would for a member who has not signed in.
    let signedOut = Router()
    signedOut.open(link)
    #expect(kept.selectedTab == signedOut.selectedTab)
    #expect(kept.paths == signedOut.paths)
    #expect(kept.sheet == signedOut.sheet)
    #expect(kept.findSearch == signedOut.findSearch)
    #expect(shown.selectedTab == .circle)
    #expect(shown.paths.values.allSatisfy { $0.isEmpty })
    #expect(shown.sheet == nil)
    #expect(shown.findSearch == .search())
  }

  // A destination that no longer loads closes on every tab, with whatever
  // was opened above it.
  @Test func closesDestinationsOnEveryTab() {
    let router = Router()
    router[stack: .circle] = [.title(id: "tv:201"), .profile(username: "ben"), .feed()]
    router[stack: .friends] = [.profile(username: "ben")]
    router[stack: .find] = [.title(id: "tv:201")]

    router.close { $0 == .profile(username: "ben") }

    #expect(router[stack: .circle] == [.title(id: "tv:201")])
    #expect(router[stack: .friends] == [])
    #expect(router[stack: .find] == [.title(id: "tv:201")])
    #expect(router.selectedTab == .circle)
  }
}
