import Foundation
import Observation

// The title page's own actions, as on the web: Recommend, the top 10 with
// its replacement when the list is full, the watch status and last-finished
// date, and the review. One write runs at a time. A write that would take the
// title out of the viewer's top 10 asks first, and each write reads the page
// again. The screen's `ScreenModel` supplies the page; this model keeps what
// the reader is doing, which outlives a failed read.
@MainActor
@Observable
public final class TitlePageModel {
  // The header control a failure reports beneath.
  public enum Control: Hashable, Sendable {
    case recommend
    case topTen
    case status
  }

  public struct Failure: Hashable, Sendable {
    public let control: Control
    public let message: String
  }

  // What shows over the page: the status choices with the finished date, the
  // review form, or the full top 10's replacement choice.
  public enum Sheet: String, Hashable, Sendable, Identifiable {
    case status
    case review
    case replace

    public var id: String { rawValue }
  }

  public enum Write: Hashable, Sendable {
    case idle
    case saving
  }

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void

  // The surface a Want to watch save reports.
  public let surface: SaveSurface
  public let review: ReviewEditor
  public private(set) var write = Write.idle
  public private(set) var failure: Failure?
  public var sheet: Sheet?
  // Withdrawing a ranked Recommend, or switching it to Want to watch, waiting
  // for the member's confirmation.
  public var leaving: TopTenLeaving?
  // A failed replacement, shown with the choices until they close.
  public private(set) var replaceFailure: String?

  // `refresh` reads the page again, such as `ScreenModel.refresh()`.
  public init(
    api: any ScreenrAPI,
    surface: SaveSurface = .title,
    refresh: @escaping @MainActor () async -> Void
  ) {
    self.api = api
    self.surface = surface
    self.refresh = refresh
    review = ReviewEditor(api: api, refresh: refresh)
  }

  public func failure(for control: Control) -> String? {
    guard let failure, failure.control == control else { return nil }
    return failure.message
  }

  // A prompt closes once the page no longer needs it, such as after a change
  // in another app or on the web: the replacement once the title is listed,
  // and a confirmation once the title has no ranked Recommend to lose.
  public func reconcile(with header: TitleHeader) {
    if sheet == .replace, header.rank != nil { sheet = nil }
    if leaving != nil, !header.recommended || header.rank == nil { leaving = nil }
  }

  // MARK: - Recommend and the top 10

  // Recommends the title, or withdraws the Recommend, asking first when that
  // takes the title out of the top 10.
  public func toggleRecommend(_ header: TitleHeader) async {
    if header.recommended, let rank = header.rank {
      failure = nil
      leaving = .withdraw(name: header.title.name, rank: rank)
      return
    }
    await run(
      .recommend,
      .activity(title: header.title.id, .recommended, value: !header.recommended)
    )
  }

  // Adds the title, which also recommends it, or removes it from the top 10,
  // which keeps the Recommend. A full list asks which title to remove.
  public func changeTopTen(_ header: TitleHeader) async {
    if header.rank != nil {
      await run(.topTen, .topTen(title: header.title.id, .remove))
    } else if header.isTopTenFull {
      failure = nil
      replaceFailure = nil
      sheet = .replace
    } else {
      await run(.topTen, .topTen(title: header.title.id, .add()))
    }
  }

  // The full list's choice: `entry` leaves the list and stays recommended,
  // the titles below it move up, and this title joins at #10.
  public func replace(_ entry: TopTenEntry, for header: TitleHeader) async {
    guard write == .idle else { return }
    write = .saving
    replaceFailure = nil
    do throws(APIError) {
      _ = try await api.send(.topTen(title: header.title.id, .add(replacing: entry.id)))
    } catch {
      write = .idle
      replaceFailure = error.explanation
      return
    }
    if sheet == .replace { sheet = nil }
    await refresh()
    write = .idle
  }

  // MARK: - Status

  // Saves a status chosen in the status sheet, or clears it with nil.
  // Finished records `today`, `YYYY-MM-DD`. Switching a ranked Recommend to
  // Want to watch asks first, in the sheet.
  public func choose(_ status: WatchStatus?, for header: TitleHeader, today: String) async {
    guard status != header.status else {
      sheet = nil
      return
    }
    if status == .wantToWatch, header.recommended, let rank = header.rank {
      failure = nil
      leaving = .switchToWantToWatch(name: header.title.name, rank: rank)
      return
    }
    sheet = nil
    await run(
      .status,
      .watchStatus(
        title: header.title.id,
        status,
        finishedOn: status == .finished ? today : nil,
        surface: status == .wantToWatch ? surface : nil
      )
    )
  }

  // Changes the last-finished date, `YYYY-MM-DD`, or clears it with nil.
  public func saveFinishedDate(_ date: String?, for header: TitleHeader) async {
    sheet = nil
    await run(.status, .finishedDate(title: header.title.id, date: date))
  }

  // Runs a confirmed withdrawal or switch, which the confirmation passes
  // since dismissing it clears `leaving`.
  public func confirm(_ leaving: TopTenLeaving, for header: TitleHeader) async {
    if self.leaving == leaving { self.leaving = nil }
    switch leaving {
    case .withdraw:
      await run(.recommend, .activity(title: header.title.id, .recommended, value: false))
    case .switchToWantToWatch:
      sheet = nil
      await run(
        .status,
        .watchStatus(title: header.title.id, .wantToWatch, surface: surface)
      )
    }
  }

  // MARK: - Review

  // Opens the review form from the saved review, or empty.
  public func openReview(_ header: TitleHeader) {
    review.start(from: header.review)
    sheet = .review
  }

  public func saveReview(for header: TitleHeader) async {
    guard await review.save(title: header.title.id), sheet == .review else { return }
    sheet = nil
  }

  public func removeReview(for header: TitleHeader) async {
    guard await review.remove(title: header.title.id), sheet == .review else { return }
    sheet = nil
  }

  // MARK: - Writes

  private func run<Response>(_ control: Control, _ request: APIRequest<Response>) async {
    guard write == .idle else { return }
    write = .saving
    failure = nil
    defer { write = .idle }
    do throws(APIError) {
      _ = try await api.send(request)
    } catch {
      failure = Failure(control: control, message: error.explanation)
      return
    }
    await refresh()
  }
}

// The review form's draft and its save and removal. The draft starts from
// the saved review each time the form opens, and closing the form discards
// changes, as on the web. A failure keeps the form and its draft.
@MainActor
@Observable
public final class ReviewEditor {
  public enum Step: Hashable, Sendable {
    case editing
    // Remove review waits for the member's confirmation.
    case confirmingRemoval
  }

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void

  public private(set) var draft = ReviewDraft()
  public private(set) var state = WriteState.idle
  public var step = Step.editing

  init(api: any ScreenrAPI, refresh: @escaping @MainActor () async -> Void) {
    self.api = api
    self.refresh = refresh
  }

  public var canSave: Bool { !draft.isEmpty && state != .saving }

  public func start(from saved: ReviewDraft?) {
    draft = saved ?? ReviewDraft()
    state = .idle
    step = .editing
  }

  // Chooses a rating from 1 to 5 stars, or clears it with nil.
  public func rate(_ rating: Int?) {
    guard let rating else {
      draft.rating = nil
      return
    }
    draft.rating = min(max(rating, 1), 5)
  }

  public func setBody(_ body: String) {
    draft.body = String(body.prefix(ReviewDraft.maximumLength))
  }

  public func setSpoiler(_ spoiler: Bool) {
    draft.spoiler = spoiler
  }

  // Saves the draft and reads the page again. Returns whether it saved.
  func save(title: String) async -> Bool {
    guard canSave else { return false }
    return await send(
      .review(title: title, rating: draft.rating, body: draft.body, spoiler: draft.spoiler)
    )
  }

  // Erases the rating and text, after the confirmation.
  func remove(title: String) async -> Bool {
    step = .editing
    guard state != .saving else { return false }
    return await send(.removeReview(title: title))
  }

  private func send<Response>(_ request: APIRequest<Response>) async -> Bool {
    state = .saving
    do throws(APIError) {
      _ = try await api.send(request)
    } catch {
      state = .failed(error.explanation)
      return false
    }
    await refresh()
    state = .idle
    return true
  }
}
