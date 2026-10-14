import Foundation
import Testing

@testable import ScreenrKit

// The Friends page, as the web's People page sorts it and sends its actions.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct FriendsModelTests {
  private func people(_ fixture: String = "screen/people/default") throws -> (PeopleScreen, String)
  {
    let screen = try screen(fixture)
    guard case .people(let page) = screen.content else {
      throw FeedFixtureError(description: "\(fixture) is not Friends")
    }
    return (page, screen.user.userId)
  }

  private func person(_ username: String) -> Person {
    Person(
      userId: "user-\(username)",
      username: username,
      displayName: username.capitalized,
      photo: nil
    )
  }

  @Test func sortsConnectionsLikeTheWeb() throws {
    let (page, viewer) = try people()
    let sections = FriendsSections(page, viewer: viewer)

    #expect(sections.requests.map(\.username) == ["fay"])
    // A friendship either person requested.
    #expect(sections.friends.map(\.username) == ["ben", "cam", "hana"])
    #expect(sections.sent.map(\.username) == ["gus"])
    #expect(sections.suggestions.map(\.person.username) == ["erin"])
    #expect(sections.blocked.map(\.username) == ["dana"])
    #expect(!sections.isEmpty)

    let suggestion = try #require(sections.suggestions.first)
    #expect(suggestion.mutualFriendsLabel == "Mutual friends: ")
    #expect(
      suggestion.mutualFriends.map(\.nameAndUsername) == ["Ben Ortiz (@ben)", "Cam Rivera (@cam)"]
    )
  }

  @Test func anEmptyPageHasNoSections() throws {
    let (page, viewer) = try people("screen/people/empty")
    let sections = FriendsSections(page, viewer: viewer)

    #expect(sections.isEmpty)
    #expect(sections.suggestions.isEmpty)
    #expect(sections.blocked.isEmpty)
  }

  @Test(arguments: [
    (FriendsModel.Action.accept, "accept"), (.decline, "remove"), (.cancel, "remove"),
    (.request, "request"), (.unblock, "unblock"),
  ])
  func sendsEachActionAndReadsAgain(_ action: FriendsModel.Action, _ sent: String) async {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    let refreshes = RefreshCounter()
    let model = FriendsModel(api: api) { await refreshes.refresh() }

    await model.run(action, for: person("fay"))

    #expect(
      api.requests == [
        .init(
          method: .post,
          action: "relationship",
          query: [:],
          body: ["target": "user-fay", "action": .string(sent)]
        )
      ]
    )
    #expect(refreshes.count == 1)
    #expect(model.pending == nil)
    #expect(model.failure(for: person("fay")) == nil)
  }

  @Test func declineAsksFirst() async {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    let model = FriendsModel(api: api) {}

    model.askToDecline(person("fay"))
    #expect(model.declining == person("fay"))
    model.cancelDecline()
    #expect(model.declining == nil)
    #expect(api.requests.isEmpty)

    model.askToDecline(person("fay"))
    await model.run(.decline, for: person("fay"))
    #expect(model.declining == nil)
    #expect(api.requests.count == 1)
  }

  @Test func aFailedActionShowsWithItsPersonUntilTheirNextAction() async {
    let api = RecordingAPI(
      sequences: ["relationship": [.failure(.notFound), .success(["ok": true])]]
    )
    let refreshes = RefreshCounter()
    let model = FriendsModel(api: api) { await refreshes.refresh() }

    await model.run(.accept, for: person("fay"))

    #expect(model.failure(for: person("fay")) == "The relationship failed.")
    #expect(model.failure(for: person("gus")) == nil)
    #expect(refreshes.count == 0)

    await model.run(.accept, for: person("fay"))
    #expect(model.failure(for: person("fay")) == nil)
    #expect(refreshes.count == 1)
  }

  // The page stays busy until it has read again, as on the web.
  @Test func runsOneActionAtATime() async {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    var model: FriendsModel?
    var pendingWhileReading: FriendsModel.Pending?
    model = FriendsModel(api: api) {
      pendingWhileReading = model?.pending
      model?.askToDecline(person("fay"))
      await model?.run(.cancel, for: person("gus"))
    }

    await model?.run(.accept, for: person("fay"))

    #expect(pendingWhileReading == .init(person: "user-fay", action: .accept))
    #expect(model?.declining == nil)
    #expect(api.requests.count == 1)
    #expect(model?.pending == nil)
  }

  @Test(arguments: [
    ("erin", "erin"), ("  Erin_2  ", "erin_2"), ("abc", "abc"),
    (String(repeating: "a", count: 24), String(repeating: "a", count: 24)),
  ])
  func searchOpensAnExactUsername(_ text: String, _ username: String) {
    let model = FriendsModel(api: RecordingAPI()) {}
    model.username = text
    #expect(model.searchDestination == .profile(username: username))
  }

  @Test(arguments: ["", "ab", "erin walsh", "erin!", "émile", String(repeating: "a", count: 25)])
  func searchWaitsForAUsername(_ text: String) {
    let model = FriendsModel(api: RecordingAPI()) {}
    model.username = text
    #expect(model.searchDestination == nil)
  }

  // Find opens the profile and clears the search, or says what a username
  // is until the search names one.
  @Test func findOpensAProfileOrSaysWhatAUsernameIs() {
    let model = FriendsModel(api: RecordingAPI()) {}
    model.username = "erin walsh"

    #expect(model.find() == nil)
    #expect(model.searchProblem == "Enter a username of 3–24 letters, numbers, or underscores.")
    #expect(model.username == "erin walsh")

    model.username = "Erin"
    #expect(model.find() == .profile(username: "erin"))
    #expect(model.searchProblem == nil)
    #expect(model.username == "")
  }
}
