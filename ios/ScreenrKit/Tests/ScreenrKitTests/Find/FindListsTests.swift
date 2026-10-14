import Foundation
import Testing

@testable import ScreenrKit

// What Find a title lists: My services across search results and both lists,
// Friends recommend's own filters and actions, and the web's wording.
@MainActor
struct FindListsTests {
  private func model() -> FindModel {
    FindModel(api: FindAPI([:]), clock: TestClock())
  }

  private func names(_ titles: [some Identifiable<String>]) -> [String] {
    titles.map(\.id)
  }

  @Test func myServicesKeepsTitlesOnSavedServicesOrFree() throws {
    let alice = try FindData.page("screen/search/default")
    let cam = try FindData.page("screen/search/viewer-statuses")
    let results = try FindData.results()
    let model = model()
    #expect(model.visibleSuggestions(cam).count == cam.suggestions.count)

    model.serviceFilter = .myServices

    // Alice saved Netflix and Hulu; Cam saved nothing, so only free titles stay.
    #expect(names(model.visibleSuggestions(alice)) == ["movie:105", "tv:204"])
    #expect(names(model.visibleSuggestions(cam)) == ["movie:102"])
    #expect(names(model.visibleResults(results, serviceIds: alice.serviceIds)) == ["movie:101"])
    #expect(names(model.friendsRecommend(cam).titles) == ["movie:102"])
    // Without the saved services, such as after a failed read, nothing stays.
    #expect(model.visibleResults(results, serviceIds: nil).isEmpty)
  }

  @Test func countsTitlesWithUnknownViewingOptions() throws {
    let cam = try FindData.page("screen/search/viewer-statuses")
    let model = model()
    #expect(model.unknownViewingNotice(cam) == nil)

    model.serviceFilter = .myServices
    #expect(
      model.unknownViewingNotice(cam)
        == "1 title has unknown viewing options. Turn off My services to see it."
    )
    model.list = .friendsRecommend
    #expect(model.unknownViewingNotice(cam) == nil)

    let page = try FindData.page(suggestions: [
      FindData.title("movie:1", "One", fields: suggestionFields(viewing: "unavailable")),
      FindData.title("movie:2", "Two", fields: suggestionFields(viewing: "unavailable")),
    ])
    model.list = .suggestions
    #expect(
      model.unknownViewingNotice(page)
        == "2 titles have unknown viewing options. Turn off My services to see them."
    )
  }

  @Test func filtersFriendsRecommendByKind() throws {
    let cam = try FindData.page("screen/search/viewer-statuses")
    let model = model()
    #expect(model.friendsRecommend(cam).titles.count == 13)

    model.kindFilter = .tv
    #expect(names(model.friendsRecommend(cam).titles) == ["tv:201"])
    model.kindFilter = .movies
    #expect(model.friendsRecommend(cam).titles.count == 12)
  }

  @Test func hidesFinishedTitlesUntilShown() throws {
    let page = try FindData.page(recommendations: [
      FindData.recommendation("movie:1", "One", status: "finished"),
      FindData.recommendation("movie:2", "Two", status: "stopped"),
      FindData.recommendation("tv:3", "Three", status: "finished"),
    ])
    let model = model()
    #expect(names(model.friendsRecommend(page).titles) == ["movie:2"])

    model.kindFilter = .tv
    #expect(
      model.friendsRecommend(page)
        == FriendsRecommendList(
          titles: [],
          emptyMessage:
            "You finished the only TV recommendation. Turn on Show finished to see it."
        )
    )

    model.finishedFilter = .shown
    #expect(names(model.friendsRecommend(page).titles) == ["tv:3"])
  }

  @Test func explainsAnEmptyFriendsRecommend() throws {
    let page = try FindData.page(recommendations: [
      FindData.recommendation("movie:1", "One", status: "finished"),
      FindData.recommendation("movie:2", "Two", status: "finished"),
      FindData.recommendation("tv:3", "Three", viewing: FindData.viewing("ok", ["subs": ["x"]])),
    ])
    let model = model()

    model.kindFilter = .movies
    #expect(
      model.friendsRecommend(page).emptyMessage
        == "You finished all 2 movie recommendations. Turn on Show finished to see them."
    )
    model.serviceFilter = .myServices
    model.kindFilter = .tv
    #expect(
      model.friendsRecommend(page).emptyMessage
        == "No TV recommendations on your services or free. Turn off My services to see all TV recommendations."
    )
    model.kindFilter = .all
    #expect(
      model.friendsRecommend(try FindData.page()).emptyMessage
        == "No recommendations on your services or free. Turn off My services to see all recommendations."
    )
    model.serviceFilter = .allServices
    #expect(model.friendsRecommend(try FindData.page()).emptyMessage == "No recommendations yet.")
  }

  @Test func explainsEmptyResults() throws {
    let results = try FindData.results()
    let model = model()
    #expect(model.resultsMessage([], serviceIds: []) == "No matches. Try a different title.")
    #expect(model.resultsMessage(results, serviceIds: []) == nil)

    model.serviceFilter = .myServices
    #expect(
      model.resultsMessage(results, serviceIds: ["service:hulu"])
        == "No matches on your services or free. Turn off My services to see all results."
    )
    #expect(model.resultsMessage(results, serviceIds: ["service:netflix"]) == nil)
  }

  @Test func summarizesAFinishedSearch() async throws {
    let api = FindAPI([
      "night": .body(try TestFixtures.body("actions/search/results")),
      "none": .body(Data("[]".utf8)),
    ])
    let model = FindModel(api: api, clock: TestClock())
    #expect(model.searchSummary(serviceIds: []) == nil)

    model.edit("night")
    model.submit()
    if let search = model.searchTask { await finish(search) }
    #expect(model.searchSummary(serviceIds: []) == "2 results")
    model.serviceFilter = .myServices
    #expect(model.searchSummary(serviceIds: ["service:netflix"]) == "1 result")

    model.edit("none")
    model.submit()
    if let search = model.searchTask { await finish(search) }
    #expect(model.searchSummary(serviceIds: []) == "No results")
  }

  @Test func offersOneActionForEachRecommendation() throws {
    let alice = try FindData.page("screen/search/default")
    let cam = try FindData.page("screen/search/viewer-statuses")
    let actions = Dictionary(uniqueKeysWithValues: cam.recommendations.map { ($0.id, $0.action) })

    #expect(actions["movie:101"] == .removeWantToWatch)
    #expect(actions["tv:201"] == .status(.caughtUp))
    #expect(actions["movie:301"] == .addWantToWatch)
    #expect(alice.recommendations.first?.action == .recommended)
    #expect(
      [
        RecommendationAction.addWantToWatch, .removeWantToWatch, .recommended,
        .status(.watching), .status(.caughtUp), .status(.finished), .status(.stopped),
      ]
      .map(\.label) == [
        "Want to watch", "Want to watch", "Recommended", "Watching", "Caught up", "Finished",
        "Stopped watching",
      ]
    )
    // Another status wins over the viewer's Recommend, as on the web.
    let page = try FindData.page(recommendations: [
      FindData.recommendation("movie:1", "One", status: "watching", recommended: true)
    ])
    #expect(page.recommendations.first?.action == .status(.watching))
  }

  @Test func namesWhoRecommendsEachTitle() throws {
    let cam = try FindData.page("screen/search/viewer-statuses")
    let night = try #require(cam.recommendations.first { $0.id == "movie:101" })
    let text = night.recommendedByText
    #expect(String(text.characters) == "Recommended by Alice Park (#1) and Ben Ortiz (#1)")
    let emphasized = text.runs
      .filter { $0.inlinePresentationIntent == .stronglyEmphasized }
      .map { String(text[$0.range].characters) }
    #expect(emphasized == ["Alice Park", "Ben Ortiz"])

    let page = try FindData.page(recommendations: [
      FindData.recommendation(
        "movie:1",
        "One",
        by: [("Maya Chen", 1), ("Sam Okafor", nil), ("Theo Park", 4)]
      )
    ])
    let three = try #require(page.recommendations.first)
    #expect(
      String(three.recommendedByText.characters)
        == "Recommended by Maya Chen (#1), Sam Okafor, and Theo Park (#4)"
    )
  }

  @Test func explainsEachSuggestion() throws {
    let alice = try FindData.page("screen/search/default")
    #expect(
      alice.suggestions.map(\.reasons) == [
        ["Cam Rivera recommends this.", "Ben Ortiz wants to watch this."],
        ["Cam Rivera is watching."],
      ]
    )
    let cam = try FindData.page("screen/search/viewer-statuses")
    let meridian = try #require(cam.suggestions.first { $0.id == "movie:104" })
    #expect(meridian.reasons == ["Alice Park, Ben Ortiz want to watch this."])

    let page = try FindData.page(suggestions: [
      FindData.title(
        "movie:1",
        "One",
        fields: suggestionFields(
          recommendedBy: [["username": "ben", "display_name": "Ben Ortiz", "rank": 2]],
          secondDegree: (recommended: 2, wanted: 1, watching: 3)
        )
      )
    ])
    #expect(
      page.suggestions.first?.reasons == [
        "Ben Ortiz (#2) recommends this.",
        "2 friends of friends also recommend this.",
        "1 friend of a friend wants to watch this.",
        "3 friends of friends are watching.",
      ]
    )
  }

  private func suggestionFields(
    viewing: String = "ok",
    recommendedBy: [JSONValue] = [],
    secondDegree: (recommended: Int, wanted: Int, watching: Int) = (0, 0, 0)
  ) -> [String: JSONValue] {
    [
      "viewing": FindData.viewing(viewing),
      "recommended_by": .array(recommendedBy), "wanted_by": [], "watching_by": [],
      "second_degree_recommended": .integer(secondDegree.recommended),
      "second_degree_wanted": .integer(secondDegree.wanted),
      "second_degree_watching": .integer(secondDegree.watching),
    ]
  }
}
