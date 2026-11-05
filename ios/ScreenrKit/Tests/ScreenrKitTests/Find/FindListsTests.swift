import Foundation
import Testing

@testable import ScreenrKit

// What Find a title lists: My services across search results and both lists,
// Friends recommend's own filters and actions, the screen read's filters, and
// the web's wording.
@MainActor
struct FindListsTests {
  private func model() -> FindModel {
    FindModel(api: FindAPI([:]), clock: TestClock())
  }

  private func names(_ titles: [some Identifiable<String>]) -> [String] {
    titles.map(\.id)
  }

  // The IDs a list shows, or none when it shows its empty state.
  private func names<Item: Identifiable<String>>(_ list: FindListContent<Item>) -> [String] {
    guard case .listed(let titles, _) = list else { return [] }
    return names(titles)
  }

  private func emptyMessage<Item>(_ list: FindListContent<Item>) -> String? {
    guard case .listed(_, let message) = list else { return nil }
    return message
  }

  @Test func myServicesKeepsTitlesOnSavedServicesOrFree() throws {
    let alice = try FindData.page("screen/search/default")
    let cam = try FindData.page("screen/search/viewer-statuses")
    let results = try FindData.results()
    let model = model()
    #expect(names(model.suggestions(cam)) == names(cam.suggestions))

    model.serviceFilter = .myServices

    // Alice saved Netflix and Hulu; Cam saved nothing, so only free titles stay.
    #expect(names(model.suggestions(alice)) == ["movie:105", "tv:204"])
    #expect(names(model.suggestions(cam)) == ["movie:102"])
    #expect(names(model.visibleResults(results, serviceIds: alice.serviceIds)) == ["movie:101"])
    #expect(names(model.friendsRecommend(cam)) == ["movie:102"])
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
    #expect(names(model.friendsRecommend(cam)).count == 13)

    model.kindFilter = .tv
    #expect(names(model.friendsRecommend(cam)) == ["tv:201"])
    model.kindFilter = .movies
    #expect(names(model.friendsRecommend(cam)).count == 12)
  }

  @Test func hidesFinishedTitlesUntilShown() throws {
    let page = try FindData.page(recommendations: [
      FindData.recommendation("movie:1", "One", status: "finished"),
      FindData.recommendation("movie:2", "Two", status: "stopped"),
      FindData.recommendation("tv:3", "Three", status: "finished"),
    ])
    let model = model()
    #expect(names(model.friendsRecommend(page)) == ["movie:2"])

    model.kindFilter = .tv
    #expect(
      model.friendsRecommend(page)
        == .listed(
          [],
          emptyMessage:
            "You finished the only TV recommendation. Turn on Show finished to see it."
        )
    )

    model.finishedFilter = .shown
    #expect(names(model.friendsRecommend(page)) == ["tv:3"])
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
      emptyMessage(model.friendsRecommend(page))
        == "You finished all 2 movie recommendations. Turn on Show finished to see them."
    )
    model.serviceFilter = .myServices
    model.kindFilter = .tv
    #expect(
      emptyMessage(model.friendsRecommend(page))
        == "No TV recommendations on your services or free. Turn off My services to see all TV recommendations."
    )
    model.kindFilter = .all
    #expect(
      emptyMessage(model.friendsRecommend(try FindData.page()))
        == "No recommendations on your services or free. Turn off My services to see all recommendations."
    )
    model.serviceFilter = .allServices
    #expect(model.friendsRecommend(try FindData.page()) == .nothingYet)
  }

  // Each filter goes in the screen read's path, in the web's order, so the
  // server applies it before capping the lists. Finished titles start hidden,
  // as in Find's first read.
  @Test func readsTheListsWithTheirFilters() {
    let model = model()
    #expect(model.screenPath == "/search?finished=hidden")
    #expect(model.screenPath == FindModel.initialScreenPath)
    #expect(Destination.search().screenPath == FindModel.initialScreenPath)
    #expect(
      Destination.search(query: "Lost", tab: .friendsRecommend).screenPath == model.screenPath
    )

    model.serviceFilter = .myServices
    model.kindFilter = .movies
    #expect(model.screenPath == "/search?services=mine&type=movie&finished=hidden")
    model.kindFilter = .tv
    model.finishedFilter = .shown
    #expect(model.screenPath == "/search?services=mine&type=tv")
    model.serviceFilter = .allServices
    model.kindFilter = .all
    #expect(model.screenPath == "/search")
  }

  // A read that hides finished titles counts the ones it left out, which
  // Show finished's empty message counts with any the phone hides.
  @Test func countsFinishedTitlesTheReadLeftOut() throws {
    let page = try FindData.page(
      recommendations: [FindData.recommendation("tv:3", "Three", status: "finished")],
      finishedRecommendations: 4
    )
    let model = model()
    #expect(
      model.friendsRecommend(page)
        == .listed(
          [],
          emptyMessage: "You finished all 5 recommendations. Turn on Show finished to see them."
        )
    )
    let none = try FindData.page(finishedRecommendations: 1)
    #expect(
      emptyMessage(model.friendsRecommend(none))
        == "You finished the only recommendation. Turn on Show finished to see it."
    )

    // Show finished counts none; the read with finished titles lists them.
    model.finishedFilter = .shown
    #expect(names(model.friendsRecommend(page)) == ["tv:3"])
  }

  // A filtered read can list nothing while other titles exist, so an empty
  // list keeps its filters and explains them, as on the web.
  @Test func keepsTheFiltersWhenAFilteredReadIsEmpty() throws {
    let empty = try FindData.page()
    let model = model()
    #expect(model.suggestions(empty) == .nothingYet)
    #expect(model.friendsRecommend(empty) == .nothingYet)

    model.kindFilter = .tv
    #expect(
      model.friendsRecommend(empty) == .listed([], emptyMessage: "No TV recommendations yet.")
    )
    model.kindFilter = .all
    model.serviceFilter = .myServices
    #expect(
      model.suggestions(empty)
        == .listed(
          [],
          emptyMessage:
            "No suggestions on your services or free. Turn off My services to see all suggestions."
        )
    )
    #expect(
      emptyMessage(model.friendsRecommend(empty))
        == "No recommendations on your services or free. Turn off My services to see all recommendations."
    )
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
