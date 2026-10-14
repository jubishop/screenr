import Foundation
import ScreenrKit
import Testing

// The title page's header actions against scripted writes: each sends what
// the web sends, asks first where the web does, and reads the page again.
@MainActor
struct TitlePageModelTests {
  // Alice's header on a title fixture.
  static func header(_ fixture: String, viewer: String = "user-alice") throws -> TitleHeader {
    guard case .title(let page) = try screen("screen/title/\(fixture)").content else {
      throw FeedFixtureError(description: "\(fixture) is not a title page")
    }
    return TitleHeader(page, viewer: viewer)
  }

  private func model(
    _ api: RecordingAPI,
    surface: SaveSurface = .title,
    refresh: RefreshCounter
  ) -> TitlePageModel {
    TitlePageModel(api: api, surface: surface) { await refresh.refresh() }
  }

  @Test func readsTheViewersPlaceFromThePage() throws {
    let movie = try Self.header("movie")
    #expect(movie.recommended)
    #expect(movie.rank == 1)
    #expect(movie.topTenLabel == "#1 in your top 10")
    #expect(movie.recommendLabel == "Recommended")
    #expect(movie.status == nil)
    #expect(movie.statusLabel == "Want to watch")
    #expect(movie.review == nil)
    #expect(movie.reviewLabel == "Rate or review")
    #expect(movie.details == "Movie · 2024")
    #expect(movie.statusOptions == [.wantToWatch, .watching, .finished, .stopped])
    #expect(!movie.showsFinishedDate)

    let finished = try Self.header("finished-review")
    #expect(finished.status == .finished)
    #expect(finished.finishedOn == "2026-09-20")
    #expect(finished.showsFinishedDate)
    #expect(
      finished.review
        == ReviewDraft(rating: 3, body: "Lovely score, slow middle.", spoiler: false)
    )
    #expect(finished.reviewLabel == "Edit your review")

    let tv = try Self.header("tv")
    #expect(tv.statusOptions.contains(.caughtUp))
    #expect(tv.details == "TV show · 2021")

    let full = try Self.header("full-top-ten")
    #expect(!full.recommended)
    #expect(full.rank == nil)
    #expect(full.isTopTenFull)
    #expect(full.topTenLabel == "Add to top 10")
    #expect(full.recommendLabel == "Recommend to friends")

    let unknown = try Self.header("unknown-availability")
    #expect(unknown.status == .wantToWatch)
    #expect(unknown.overview == "No synopsis available.")
    #expect(!unknown.showsFinishedDate)
  }

  @Test func recommendsWithoutASurface() async throws {
    let api = RecordingAPI(["activity": .success(["id": "1"])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)

    await model.toggleRecommend(try Self.header("full-top-ten"))

    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:105", "field": "recommended", "value": true]
      ]
    )
    #expect(refresh.count == 1)
    #expect(model.write == .idle)
  }

  // Withdrawing a ranked Recommend asks first, and confirming withdraws it.
  @Test func asksBeforeARankedRecommendLeavesTheTopTen() async throws {
    let api = RecordingAPI(["activity": .success(["id": "1"])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let movie = try Self.header("movie")

    await model.toggleRecommend(movie)
    #expect(api.requests.isEmpty)
    let leaving = try #require(model.leaving)
    #expect(
      leaving.message
        == "Remove your recommendation? Night Crossing also leaves your top 10 at #1."
    )
    #expect(leaving.action == "Remove recommendation")

    await model.confirm(leaving, for: movie)
    #expect(model.leaving == nil)
    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:101", "field": "recommended", "value": false]
      ]
    )
    #expect(refresh.count == 1)
  }

  @Test func addsToAndRemovesFromTheTopTen() async throws {
    let api = RecordingAPI(["top-ten": .success(["ok": true])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)

    await model.changeTopTen(try Self.header("unknown-availability"))
    await model.changeTopTen(try Self.header("movie"))

    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:104", "change": "add"],
        ["title": "movie:101", "change": "remove"],
      ]
    )
    #expect(refresh.count == 2)
  }

  // A full list asks which title to remove; the choice replaces it.
  @Test func replacesATitleWhenTheTopTenIsFull() async throws {
    let api = RecordingAPI(["top-ten": .success(["ok": true])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let full = try Self.header("full-top-ten")

    await model.changeTopTen(full)
    #expect(model.sheet == .replace)
    #expect(api.requests.isEmpty)

    let lanterns = try #require(full.topTen.first { $0.name == "Paper Lanterns" })
    await model.replace(lanterns, for: full)
    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:105", "change": "add", "replace": "movie:102"]
      ]
    )
    #expect(model.sheet == nil)
    #expect(refresh.count == 1)
  }

  @Test func keepsTheChoicesOpenWhenAReplacementFails() async throws {
    let api = RecordingAPI(["top-ten": .failure(.rejected(status: 400))])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let full = try Self.header("full-top-ten")

    await model.changeTopTen(full)
    await model.replace(try #require(full.topTen.first), for: full)

    #expect(model.sheet == .replace)
    #expect(model.replaceFailure == "The top-ten failed.")
    #expect(model.write == .idle)
    #expect(refresh.count == 0)
  }

  // Choosing Want to watch sends the page's surface; Finished sends today.
  @Test func savesStatusesWithTheirSurfaceAndDate() async throws {
    let api = RecordingAPI(["watch-status": .success(["id": "1"])])
    let refresh = RefreshCounter()
    let model = model(api, surface: .suggestion, refresh: refresh)
    let full = try Self.header("full-top-ten")

    model.sheet = .status
    await model.choose(.wantToWatch, for: full, today: "2026-10-14")
    #expect(model.sheet == nil)
    await model.choose(.finished, for: full, today: "2026-10-14")
    await model.choose(.watching, for: full, today: "2026-10-14")
    await model.choose(nil, for: try Self.header("unknown-availability"), today: "2026-10-14")

    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:105", "status": "want_to_watch", "surface": "suggestion"],
        ["title": "movie:105", "status": "finished", "finishedOn": "2026-10-14"],
        ["title": "movie:105", "status": "watching"],
        ["title": "movie:104", "status": .null],
      ]
    )
    #expect(refresh.count == 4)
  }

  @Test func choosingTheCurrentStatusChangesNothing() async throws {
    let api = RecordingAPI(["watch-status": .success(["id": "1"])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    model.sheet = .status

    await model.choose(.wantToWatch, for: try Self.header("unknown-availability"), today: "x")

    #expect(api.requests.isEmpty)
    #expect(model.sheet == nil)
  }

  // Switching a ranked Recommend to Want to watch asks first in the sheet.
  @Test func asksBeforeSwitchingARankedRecommendToWantToWatch() async throws {
    let api = RecordingAPI(["watch-status": .success(["id": "1"])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let movie = try Self.header("movie")
    model.sheet = .status

    await model.choose(.wantToWatch, for: movie, today: "2026-10-14")
    #expect(api.requests.isEmpty)
    #expect(model.sheet == .status)
    let leaving = try #require(model.leaving)
    #expect(leaving == .switchToWantToWatch(name: "Night Crossing", rank: 1))

    await model.confirm(leaving, for: movie)
    #expect(model.sheet == nil)
    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:101", "status": "want_to_watch", "surface": "title"]
      ]
    )
  }

  @Test func changesAndClearsTheFinishedDate() async throws {
    let api = RecordingAPI(["finished-date": .success(["ok": true])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let finished = try Self.header("finished-review")

    await model.saveFinishedDate("2026-09-21", for: finished)
    await model.saveFinishedDate(nil, for: finished)

    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:102", "date": "2026-09-21"],
        ["title": "movie:102", "date": .null],
      ]
    )
  }

  @Test func showsAFailureBeneathItsControl() async throws {
    let api = RecordingAPI(["watch-status": .failure(.server(status: 503))])
    let model = model(api, refresh: RefreshCounter())

    await model.choose(.watching, for: try Self.header("movie"), today: "2026-10-14")

    #expect(model.failure(for: .status) == "The watch-status failed.")
    #expect(model.failure(for: .recommend) == nil)
  }

  // A prompt closes once another change makes it moot.
  @Test func closesPromptsTheirTitleNoLongerNeeds() async throws {
    let model = model(RecordingAPI(), refresh: RefreshCounter())
    model.sheet = .replace
    model.reconcile(with: try Self.header("movie"))
    #expect(model.sheet == nil)

    model.leaving = .withdraw(name: "Paper Lanterns", rank: 2)
    model.reconcile(with: try Self.header("full-top-ten"))
    #expect(model.leaving == nil)
  }

  // MARK: - Review

  @Test func editsTheSavedReview() async throws {
    let api = RecordingAPI(["review": .success(["id": "1"])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let finished = try Self.header("finished-review")

    model.openReview(finished)
    #expect(model.sheet == .review)
    #expect(model.review.draft.rating == 3)
    model.review.rate(5)
    model.review.setBody("Lovely score.")
    model.review.setSpoiler(true)
    await model.saveReview(for: finished)

    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:102", "rating": 5, "body": "Lovely score.", "spoiler": true]
      ]
    )
    #expect(model.sheet == nil)
    #expect(refresh.count == 1)
  }

  // A review needs a rating or text; text alone sends no rating.
  @Test func savesAReviewWithOnlyText() async throws {
    let api = RecordingAPI(["review": .success(["id": "1"])])
    let model = model(api, refresh: RefreshCounter())
    let movie = try Self.header("movie")

    model.openReview(movie)
    #expect(model.review.draft == ReviewDraft())
    #expect(!model.review.canSave)
    model.review.setBody("   ")
    #expect(!model.review.canSave)
    model.review.setBody("Gorgeous.")
    #expect(model.review.canSave)
    await model.saveReview(for: movie)

    #expect(
      api.requests.map(\.body) == [
        ["title": "movie:101", "rating": .null, "body": "Gorgeous.", "spoiler": false]
      ]
    )
  }

  @Test func keepsTheFormAndDraftWhenASaveFails() async throws {
    let api = RecordingAPI(["review": .failure(.rejected(status: 400))])
    let model = model(api, refresh: RefreshCounter())
    let movie = try Self.header("movie")

    model.openReview(movie)
    model.review.rate(4)
    await model.saveReview(for: movie)

    #expect(model.sheet == .review)
    #expect(model.review.draft.rating == 4)
    #expect(model.review.state == .failed("The review failed."))
  }

  @Test func removesTheReviewAfterConfirming() async throws {
    let api = RecordingAPI(["remove-review": .success(["ok": true])])
    let refresh = RefreshCounter()
    let model = model(api, refresh: refresh)
    let finished = try Self.header("finished-review")

    model.openReview(finished)
    model.review.step = .confirmingRemoval
    await model.removeReview(for: finished)

    #expect(api.requests.map(\.body) == [["title": "movie:102"]])
    #expect(model.review.step == .editing)
    #expect(model.sheet == nil)
    #expect(refresh.count == 1)
  }

  @Test func limitsAReviewToItsLength() throws {
    let model = model(RecordingAPI(), refresh: RefreshCounter())
    model.openReview(try Self.header("movie"))
    model.review.setBody(String(repeating: "a", count: 2_100))
    #expect(model.review.draft.body.count == 2_000)
    model.review.rate(9)
    #expect(model.review.draft.rating == 5)
    model.review.rate(nil)
    #expect(model.review.draft.rating == nil)
  }
}
