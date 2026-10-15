import Foundation
import Testing

@testable import ScreenrKit

// A profile's relationship actions, as on the web: the visible action, More
// actions with their confirmations, and Block, which leaves for Friends.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ProfileModelTests {
  private func profile(_ fixture: String) throws -> (Profile, String) {
    let screen = try screen(fixture)
    guard case .profile(let page) = screen.content else {
      throw FeedFixtureError(description: "\(fixture) is not a profile")
    }
    return (page.profile, screen.user.userId)
  }

  private let ben = Person(
    userId: "user-ben",
    username: "ben",
    displayName: "Ben Ortiz",
    photo: nil
  )

  @Test(arguments: [
    ("screen/profile/own", Relationship.own), ("screen/profile/joined", .own),
    ("screen/profile/empty-top-ten", .own), ("screen/profile/friend", .friend),
    ("screen/profile/full-top-ten", .none), ("screen/profile/pending-request", .requestReceived),
    ("screen/profile/sent-request", .requestSent),
  ])
  func readsTheRelationship(_ fixture: String, _ expected: Relationship) throws {
    let (profile, viewer) = try profile(fixture)
    #expect(Relationship(profile, viewer: viewer) == expected)
  }

  @Test func offersEachRelationshipItsActions() {
    #expect(Relationship.own.action == nil)
    #expect(Relationship.own.menu.isEmpty)
    #expect(Relationship.friend.action == .watchTogether)
    #expect(Relationship.friend.menu == [.unfriend, .block])
    #expect(Relationship.requestSent.action?.label == "Cancel friend request")
    #expect(Relationship.requestReceived.action?.label == "Accept friend request")
    #expect(Relationship.none.action?.label == "Send friend request")
    for relationship in [Relationship.requestSent, .requestReceived, .none] {
      #expect(relationship.menu == [.block])
    }
  }

  @Test(arguments: [
    (ProfileAction.sendRequest, "request"), (.acceptRequest, "accept"), (.cancelRequest, "remove"),
  ])
  func sendsTheVisibleActionAndReadsAgain(_ action: ProfileAction, _ sent: String) async {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    let refreshes = RefreshCounter()
    let model = ProfileModel(shell: ShellModel(api: api)) { await refreshes.refresh() }

    await model.run(action, for: ben)

    #expect(api.requests.map(\.body) == [["target": "user-ben", "action": .string(sent)]])
    #expect(refreshes.count == 1)
    #expect(model.activity == .idle)
  }

  @Test func watchTogetherSendsNothing() async {
    let api = RecordingAPI()
    let model = ProfileModel(shell: ShellModel(api: api)) {}
    await model.run(.watchTogether, for: ben)
    #expect(api.requests.isEmpty)
  }

  @Test func unfriendsOnceConfirmed() async throws {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    let refreshes = RefreshCounter()
    let model = ProfileModel(shell: ShellModel(api: api)) { await refreshes.refresh() }

    model.ask(.unfriend, about: ben, .friend)
    let confirmation = try #require(model.confirmation(for: .friend))
    #expect(confirmation.title == "Unfriend Ben Ortiz?")
    #expect(
      confirmation.message == "You’ll both lose access to each other’s posts and discussions."
    )
    #expect(confirmation.action == "Unfriend")
    #expect(api.requests.isEmpty)

    await model.confirm(confirmation)

    #expect(api.requests.map(\.body) == [["target": "user-ben", "action": "remove"]])
    #expect(refreshes.count == 1)
    #expect(model.confirmation(for: .friend) == nil)
  }

  @Test func cancellingChangesNothing() {
    let api = RecordingAPI()
    let model = ProfileModel(shell: ShellModel(api: api)) {}
    model.ask(.block, about: ben, .none)
    model.cancelConfirmation()
    #expect(model.confirmation(for: .none) == nil)
    #expect(api.requests.isEmpty)
  }

  // A friendship that ended elsewhere no longer offers Unfriend.
  @Test func unfriendClosesWhenTheFriendshipEnds() {
    let model = ProfileModel(shell: ShellModel(api: RecordingAPI())) {}
    model.ask(.unfriend, about: ben, .friend)
    #expect(model.confirmation(for: .none) == nil)
    // Unfriend is only for friends.
    model.cancelConfirmation()
    model.ask(.unfriend, about: ben, .requestSent)
    #expect(model.confirmation(for: .requestSent) == nil)
  }

  @Test(arguments: [
    (Relationship.friend, "This ends your friendship. "),
    (.requestSent, "This removes the pending friend request. "),
    (.requestReceived, "This removes the pending friend request. "), (.none, ""),
  ])
  func blockSaysWhatItEnds(_ relationship: Relationship, _ effect: String) throws {
    let model = ProfileModel(shell: ShellModel(api: RecordingAPI())) {}
    model.ask(.block, about: ben, relationship)
    let confirmation = try #require(model.confirmation(for: relationship))
    #expect(confirmation.title == "Block Ben Ortiz?")
    #expect(
      confirmation.message
        == effect
        + "You won’t see each other’s profiles, posts, or comments, and neither of you can "
        + "send a friend request until you unblock them."
    )
    #expect(confirmation.action == "Block")
  }

  // Block closes the profile on every tab, with Watch together and anything
  // opened above them, and opens Friends with the result instead of reading
  // a profile that no longer loads.
  @Test func blockLeavesForFriends() async throws {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    let shell = ShellModel(api: api)
    let refreshes = RefreshCounter()
    let model = ProfileModel(shell: shell) { await refreshes.refresh() }
    shell.router.selectedTab = .circle
    shell.router[stack: .circle] = [.title(id: "tv:201"), .profile(username: "Ben"), .feed()]
    shell.router[stack: .friends] = [.watchTogether(with: ["ben"]), .title(id: "movie:101")]
    shell.router[stack: .you] = [.profile(username: "cam")]

    model.ask(.block, about: ben, .friend)
    await model.confirm(try #require(model.confirmation(for: .friend)))

    #expect(api.requests.map(\.body) == [["target": "user-ben", "action": "block"]])
    #expect(refreshes.count == 0)
    #expect(model.activity == .leaving)
    #expect(shell.router.selectedTab == .friends)
    #expect(shell.router[stack: .friends] == [])
    #expect(shell.router[stack: .circle] == [.title(id: "tv:201")])
    #expect(shell.router[stack: .you] == [.profile(username: "cam")])
    #expect(shell.notices[.people] == "You blocked Ben Ortiz.")
  }

  @Test func aFailedActionShowsItsMessageAndStays() async throws {
    let api = RecordingAPI(["relationship": .failure(.server(status: 503))])
    let shell = ShellModel(api: api)
    shell.router[stack: .friends] = [.profile(username: "ben")]
    let refreshes = RefreshCounter()
    let model = ProfileModel(shell: shell) { await refreshes.refresh() }

    model.ask(.block, about: ben, .friend)
    await model.confirm(try #require(model.confirmation(for: .friend)))

    #expect(model.failure == "The relationship failed.")
    #expect(model.activity == .idle)
    #expect(shell.router[stack: .friends] == [.profile(username: "ben")])
    #expect(shell.notices.isEmpty)

    await model.run(.sendRequest, for: ben)
    #expect(model.failure == "The relationship failed.")
    #expect(refreshes.count == 0)
  }
}
