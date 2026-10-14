import Foundation
import Observation

// A Start a conversation draft. Only a TV title comment has a season, and an
// episode needs its season.
public struct StarterDraft: Hashable, Sendable {
  public var body = ""
  public var spoiler = false
  public var season: Int?
  public var episode: Int?

  public init() {}
}

// A list the composer loads once it opens, such as a show's seasons.
public enum LoadedList<Value: Hashable & Sendable>: Hashable, Sendable {
  // This composer has no such list, such as seasons for a movie.
  case notNeeded
  case loading
  case loaded(Value)
  // It could not load; the comment can still post without the label.
  case unavailable
}

// A Season or Episode picker choice, such as "Season 2 · Finale".
public struct PickerOption: Hashable, Sendable, Identifiable {
  public let number: Int
  public let label: String

  public var id: Int { number }
}

// Start a conversation: on the friends feed, a post without a title; on a
// title page, a comment about the title, which on a TV show can name a season
// or episode from TMDB's lists. Cancel closes the composer and keeps the
// draft. Posting clears only the posted draft and reads the screen again.
@MainActor
@Observable
public final class ConversationStarter {
  public enum Subject: Hashable, Sendable {
    case post
    case title(id: String, kind: TitleKind)
  }

  public let subject: Subject
  public private(set) var visibility = ComposerVisibility.closed
  public private(set) var draft = StarterDraft()
  public private(set) var state = WriteState.idle
  public private(set) var seasons = LoadedList<[Season]>.notNeeded
  private var episodes: [Int: LoadedList<[Episode]>] = [:]

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void

  public init(subject: Subject, api: any ScreenrAPI, refresh: @escaping @MainActor () async -> Void)
  {
    self.subject = subject
    self.api = api
    self.refresh = refresh
  }

  public var formLabel: String { subject == .post ? "New post" : "New title comment" }
  public var fieldLabel: String { subject == .post ? "Your post" : "Your comment" }
  public var submitLabel: String { subject == .post ? "Post" : "Post comment" }
  public var explanation: String {
    let about =
      subject == .post
      ? "Post without choosing a movie or show." : "Post a comment about this title."
    return about + " Only you and your friends can see it."
  }

  public var canPost: Bool {
    !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && state != .saving
  }

  // Opens the composer. A TV show's seasons load the first time.
  public func open() async {
    visibility = .open
    guard case .title(let id, .tv) = subject, seasons == .notNeeded else { return }
    seasons = .loading
    do throws(APIError) {
      seasons = .loaded(try await api.send(.seasons(title: id)).seasons)
    } catch {
      seasons = .unavailable
    }
  }

  public func cancel() {
    visibility = .closed
  }

  public func setBody(_ body: String) {
    draft.body = String(body.prefix(CommentDraft.maximumLength))
  }

  public func setSpoiler(_ spoiler: Bool) {
    draft.spoiler = spoiler
  }

  // MARK: - Season and episode labels

  public var seasonOptions: [PickerOption] {
    guard case .loaded(let list) = seasons else { return [] }
    return list.map { season in
      let plain = "Season \(season.number)"
      return PickerOption(
        number: season.number,
        label: season.name == plain ? plain : "\(plain) · \(season.name)"
      )
    }
  }

  // What the Season picker says, or nil when it does not show.
  public var seasonNotice: String? {
    seasons == .unavailable
      ? "Seasons are unavailable right now, so this comment will have no season label." : nil
  }

  // The chosen season's episodes.
  public var episodeList: LoadedList<[Episode]> {
    guard let season = draft.season else { return .notNeeded }
    return episodes[season] ?? .loading
  }

  public var episodeOptions: [PickerOption] {
    guard case .loaded(let list) = episodeList else { return [] }
    return list.map { episode in
      PickerOption(
        number: episode.number,
        label: "Episode \(episode.number)" + (episode.name.isEmpty ? "" : " · \(episode.name)")
      )
    }
  }

  // Chooses a season, or none, which clears the episode. Each season's
  // episodes load once.
  public func chooseSeason(_ season: Int?) async {
    draft.season = season
    draft.episode = nil
    guard case .title(let id, _) = subject, let season, episodes[season] == nil else { return }
    episodes[season] = .loading
    do throws(APIError) {
      episodes[season] = .loaded(try await api.send(.episodes(title: id, season: season)).episodes)
    } catch {
      episodes[season] = .unavailable
    }
  }

  // Chooses an episode of the chosen season, or the whole season.
  public func chooseEpisode(_ episode: Int?) {
    guard draft.season != nil else { return }
    draft.episode = episode
  }

  // MARK: - Posting

  public func post() async {
    guard canPost else { return }
    let posted = draft
    state = .saving
    do throws(APIError) {
      switch subject {
      case .post:
        _ = try await api.send(.discussionPost(body: posted.body, spoiler: posted.spoiler))
      case .title(let id, _):
        _ = try await api.send(
          .titleComment(
            title: id,
            body: posted.body,
            spoiler: posted.spoiler,
            season: posted.season,
            episode: posted.season == nil ? nil : posted.episode
          )
        )
      }
    } catch {
      state = .failed(error.explanation)
      return
    }
    if draft == posted { draft = StarterDraft() }
    state = .idle
    await refresh()
  }
}
