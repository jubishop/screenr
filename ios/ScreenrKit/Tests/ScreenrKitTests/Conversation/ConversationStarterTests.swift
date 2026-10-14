import Foundation
import Testing

@testable import ScreenrKit

// Start a conversation: a post without a title on the friends feed, or a
// title comment, optionally labeled with a season or episode, on a title page.
@MainActor
struct ConversationStarterTests {
  @Test func postsWithoutATitleAndClearsTheDraft() async {
    let api = RecordingAPI(["discussion-post": .success(["id": "post"])])
    let refreshes = RefreshCounter()
    let starter = ConversationStarter(subject: .post, api: api) { await refreshes.refresh() }
    #expect(starter.fieldLabel == "Your post")
    #expect(starter.submitLabel == "Post")
    #expect(!starter.canPost)

    await starter.open()
    starter.setBody("Movie night at my place on Friday?")
    await starter.post()

    #expect(
      api.requests.map(\.body) == [
        ["body": "Movie night at my place on Friday?", "spoiler": false]
      ]
    )
    #expect(starter.draft == StarterDraft())
    #expect(starter.state == .idle)
    #expect(starter.visibility == .open)
    #expect(refreshes.count == 1)
  }

  @Test func keepsTheDraftThroughCancelAndFailure() async {
    let api = RecordingAPI(["discussion-post": .failure(.rateLimited)])
    let starter = ConversationStarter(subject: .post, api: api) {}

    await starter.open()
    starter.setBody("Hello")
    starter.setSpoiler(true)
    starter.cancel()
    #expect(starter.visibility == .closed)
    #expect(starter.draft.body == "Hello")

    await starter.open()
    await starter.post()
    #expect(starter.draft.body == "Hello")
    #expect(starter.state == .failed("The discussion-post failed."))
  }

  @Test func labelsATVCommentWithASeasonAndEpisode() async {
    let api = RecordingAPI([
      "seasons": .success([
        "seasons": [["number": 1, "name": "Season 1"], ["number": 2, "name": "Finale"]]
      ]),
      "episodes": .success([
        "episodes": [["number": 2, "name": "Undertow"], ["number": 3, "name": ""]]
      ]),
      "title-comment": .success(["id": "comment"]),
    ])
    let starter = ConversationStarter(subject: .title(id: "tv:201", kind: .tv), api: api) {}
    #expect(starter.fieldLabel == "Your comment")
    #expect(starter.submitLabel == "Post comment")

    await starter.open()
    #expect(
      starter.seasons
        == .loaded([Season(number: 1, name: "Season 1"), Season(number: 2, name: "Finale")])
    )
    #expect(starter.seasonOptions.map(\.label) == ["Season 1", "Season 2 · Finale"])

    await starter.chooseSeason(2)
    #expect(starter.episodeOptions.map(\.label) == ["Episode 2 · Undertow", "Episode 3"])
    starter.chooseEpisode(2)
    starter.setBody("That keeper twist!")
    starter.setSpoiler(true)
    await starter.post()

    #expect(
      api.requests.map(\.action) == ["seasons", "episodes", "title-comment"]
    )
    #expect(api.requests[1].query == ["title": "tv:201", "season": "2"])
    #expect(
      api.requests.last?.body == [
        "title": "tv:201", "body": "That keeper twist!", "spoiler": true, "season": 2,
        "episode": 2,
      ]
    )
    // Posting clears the label with the draft.
    #expect(starter.draft.season == nil)
    #expect(starter.draft.episode == nil)
  }

  @Test func postsWithoutALabelWhenSeasonsAreUnavailable() async {
    let api = RecordingAPI(["seasons": .failure(.server(status: 502))])
    let starter = ConversationStarter(subject: .title(id: "tv:201", kind: .tv), api: api) {}

    await starter.open()

    #expect(starter.seasons == .unavailable)
    #expect(
      starter.seasonNotice
        == "Seasons are unavailable right now, so this comment will have no season label."
    )
  }

  @Test func asksForNoSeasonsForAMovie() async {
    let api = RecordingAPI()
    let starter = ConversationStarter(subject: .title(id: "movie:101", kind: .movie), api: api) {}
    await starter.open()
    #expect(starter.seasons == .notNeeded)
    #expect(api.requests.isEmpty)
  }

  @Test func choosingAnotherSeasonClearsTheEpisode() async {
    let api = RecordingAPI([
      "seasons": .success(["seasons": [["number": 1, "name": "Season 1"]]]),
      "episodes": .success(["episodes": [["number": 1, "name": "Arrival"]]]),
    ])
    let starter = ConversationStarter(subject: .title(id: "tv:201", kind: .tv), api: api) {}
    await starter.open()
    await starter.chooseSeason(1)
    starter.chooseEpisode(1)
    await starter.chooseSeason(nil)
    #expect(starter.draft.season == nil)
    #expect(starter.draft.episode == nil)
    // Episode lists stay loaded.
    await starter.chooseSeason(1)
    #expect(api.requests.count == 2)
  }
}
