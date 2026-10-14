import Foundation
import Observation

// A comment composer's destination: the Comment composer at the bottom of an
// entry's discussion, or the reply composer beneath one of its comments.
public enum ComposerTarget: Hashable, Sendable {
  case entry(String)
  case reply(entry: String, comment: String)

  public var entry: String {
    switch self {
    case .entry(let entry), .reply(let entry, _): entry
    }
  }
}

public struct CommentDraft: Hashable, Sendable {
  public static let maximumLength = 2_000

  public var body = ""
  public var spoiler = false

  public init(body: String = "", spoiler: Bool = false) {
    self.body = body
    self.spoiler = spoiler
  }

  // Comments need 1 to 2,000 characters after trimming outer whitespace.
  public var isPostable: Bool { !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

// A write in one place on the page, such as a composer or a reaction line.
public enum WriteState: Hashable, Sendable {
  case idle
  case saving
  // The failure, in the server's words when it sent them, shown beneath the
  // control until the next write there.
  case failed(String)
}

// The reactions to an entry, or to one of its replies.
public struct ReactionTarget: Hashable, Sendable {
  public let entry: String
  public let reply: String?

  public init(entry: String, reply: String? = nil) {
    self.entry = entry
    self.reply = reply
  }
}

// Where a failed title action or removal reports beneath its control.
public enum FeedPlace: Hashable, Sendable {
  case entry(String)
  case comment(String)
}

// What the scroll view moves to for a permalink.
public enum FeedScrollTarget: Hashable, Sendable {
  case entry(String)
  case comment(String)
}

// Members delete their own comments; an entry's author removes others'.
public enum Removal: Hashable, Sendable {
  case delete
  case remove

  public var label: String {
    switch self {
    case .delete: "Delete"
    case .remove: "Remove"
    }
  }
}

// A destructive action waiting for the member's confirmation.
public enum FeedConfirmation: Hashable, Sendable, Identifiable {
  case deleteEntry(FeedItem)
  case removeComment(Comment, Removal)
  case leaveTopTen(TopTenLeaving, FeedItem)

  public var id: String {
    switch self {
    case .deleteEntry(let item): "delete-\(item.id)"
    case .removeComment(let comment, _): "remove-\(comment.id)"
    case .leaveTopTen(let leaving, let item): "top-ten-\(item.id)-\(leaving.action)"
    }
  }

  public var message: String {
    switch self {
    case .deleteEntry(let item):
      "Delete this \(item.itemType == .post ? "post" : "comment")? Its text will be erased."
    case .removeComment(_, let removal): "\(removal.label) this comment? Its text will be erased."
    case .leaveTopTen(let leaving, _): leaving.message
    }
  }

  public var action: String {
    switch self {
    case .deleteEntry: "Delete"
    case .removeComment(_, let removal): removal.label
    case .leaveTopTen(let leaving, _): leaving.action
    }
  }
}

// The interactive feed that the friends feed, title pages, and profiles
// share. The screen's `ScreenModel` supplies each snapshot; this model holds
// what the reader did on the page, which outlives failed reads: accepted
// activity, revealed spoilers, open discussions and composers with their
// drafts, and the state of each write. After a write it asks the screen to
// read again, and the reader's own activity shows at once.
@MainActor
@Observable
public final class FeedModel {
  public enum TitleActions: Hashable, Sendable {
    case idle
    // A Want to watch or Recommend save is in flight; the others wait.
    case saving
  }

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void

  private var accepted: AcceptedActivity?
  private var revealedEntries: Set<String> = []
  private var revealedComments: Set<String> = []
  private var threads: [String: ThreadState] = [:]
  private var drafts: [ComposerTarget: CommentDraft] = [:]
  private var composerStates: [ComposerTarget: WriteState] = [:]
  private var reactionStates: [ReactionTarget: WriteState] = [:]
  // The reactions whose picker is open beneath their action line.
  public private(set) var reactionPicker: ReactionTarget?
  private var failures: [FeedPlace: String] = [:]
  public private(set) var titleActions = TitleActions.idle
  // The action waiting for confirmation, which the screen presents.
  public var confirmation: FeedConfirmation?

  // `refresh` reads the screen again, such as `ScreenModel.refresh()`.
  public init(api: any ScreenrAPI, refresh: @escaping @MainActor () async -> Void) {
    self.api = api
    self.refresh = refresh
  }

  // MARK: - Snapshots

  // What the feed shows of a snapshot. `viewer` is the reader's user ID.
  public func layout(_ snapshot: [FeedItem], viewer: String) -> FeedLayout {
    FeedLayout(snapshot: snapshot, accepted: accepted, viewer: viewer)
  }

  // Notes each new snapshot: the first is accepted as a whole, and each
  // discussion keeps the preview it first showed.
  public func receive(_ snapshot: [FeedItem], viewer: String) {
    if accepted == nil { accepted = AcceptedActivity(snapshot) }
    keepPreviews(snapshot, viewer: viewer)
  }

  // New activity: everything in the snapshot shows.
  public func showIncoming(_ snapshot: [FeedItem], viewer: String) {
    accepted = AcceptedActivity(snapshot)
    keepPreviews(snapshot, viewer: viewer)
  }

  // Shows an entry the reader chose elsewhere on the page, such as a title
  // page's friend line, accepting waiting activity as New activity would.
  public func show(entry: String, in snapshot: [FeedItem], viewer: String) {
    let shown = layout(snapshot, viewer: viewer).entries.contains { $0.id == entry }
    guard !shown, snapshot.contains(where: { $0.id == entry }) else { return }
    showIncoming(snapshot, viewer: viewer)
  }

  private func keepPreviews(_ snapshot: [FeedItem], viewer: String) {
    for entry in layout(snapshot, viewer: viewer).entries
    where threads[entry.id]?.previewIDs == nil {
      guard let preview = ThreadLayout.preview(of: entry.comments) else { continue }
      threads[entry.id, default: ThreadState()].previewIDs = preview
    }
  }

  // Where a permalink scrolls: the linked reply once its discussion shows,
  // otherwise its entry, or nil while the entry is not shown.
  public func scrollTarget(_ target: LinkTarget?, in layout: FeedLayout) -> FeedScrollTarget? {
    guard let target, let entry = layout.entries.first(where: { $0.id == target.item }) else {
      return nil
    }
    if let reply = target.reply, !isHidden(entry.item),
      entry.comments.contains(where: { $0.id == reply })
    {
      return .comment(reply)
    }
    return .entry(entry.id)
  }

  // MARK: - Spoilers

  // A spoiler entry hides its text, reactions, and whole discussion.
  public func isHidden(_ item: FeedItem) -> Bool {
    item.spoiler && !revealedEntries.contains(item.id)
  }

  public func reveal(_ item: FeedItem) {
    revealedEntries.insert(item.id)
  }

  // A reply's own spoiler flag hides its text and reactions.
  public func isHidden(_ comment: Comment) -> Bool {
    comment.spoiler && !revealedComments.contains(comment.id)
  }

  public func reveal(_ comment: Comment) {
    revealedComments.insert(comment.id)
  }

  // MARK: - Discussions

  // `targetReply` is the reply a permalink names in this entry.
  public func thread(_ entry: FeedEntry, targetReply: String? = nil) -> ThreadLayout {
    ThreadLayout(
      comments: entry.comments,
      state: threads[entry.id] ?? ThreadState(),
      targetReply: targetReply
    )
  }

  // The open reply composer in an entry's discussion, if any.
  public func openReply(in entry: String) -> ComposerTarget? {
    guard let comment = threads[entry]?.replyTo else { return nil }
    return .reply(entry: entry, comment: comment)
  }

  public func showEarlier(in entry: String) {
    threads[entry, default: ThreadState()].extent = .all
  }

  // Opens or closes a direct comment's nested replies. Closing them closes a
  // reply composer within the group.
  public func toggle(_ group: ThreadLayout.Group, in entry: String) {
    var thread = threads[entry] ?? ThreadState()
    thread.groups[group.id] = group.disclosure == .expanded ? .collapsed : .expanded
    if group.disclosure == .expanded, group.replies.contains(where: { $0.id == thread.replyTo }) {
      thread.replyTo = nil
    }
    threads[entry] = thread
  }

  // MARK: - Composers

  public func isOpen(_ target: ComposerTarget) -> Bool {
    let thread = threads[target.entry]
    switch target {
    case .entry: return thread?.directComposer == .open
    case .reply(_, let comment): return thread?.replyTo == comment
    }
  }

  // Opens a composer. An entry's discussion has one reply composer at a time.
  public func open(_ target: ComposerTarget) {
    switch target {
    case .entry(let entry): threads[entry, default: ThreadState()].directComposer = .open
    case .reply(let entry, let comment): threads[entry, default: ThreadState()].replyTo = comment
    }
  }

  // Cancel closes the composer and keeps its draft for later.
  public func close(_ target: ComposerTarget) {
    switch target {
    case .entry(let entry): threads[entry, default: ThreadState()].directComposer = .closed
    case .reply(let entry, let comment):
      if threads[entry]?.replyTo == comment { threads[entry]?.replyTo = nil }
    }
  }

  public func draft(for target: ComposerTarget) -> CommentDraft {
    drafts[target] ?? CommentDraft()
  }

  public func setBody(_ body: String, for target: ComposerTarget) {
    drafts[target, default: CommentDraft()].body = String(body.prefix(CommentDraft.maximumLength))
  }

  public func setSpoiler(_ spoiler: Bool, for target: ComposerTarget) {
    drafts[target, default: CommentDraft()].spoiler = spoiler
  }

  public func state(of target: ComposerTarget) -> WriteState {
    composerStates[target] ?? .idle
  }

  // The live comment a reply composer answers, or nil once it is gone.
  public func replyTarget(_ target: ComposerTarget, in entry: FeedEntry) -> Comment? {
    guard case .reply(_, let id) = target else { return nil }
    return entry.comments.first { $0.id == id && $0.isLive }
  }

  // "Replying to @ben", or that the comment is no longer there.
  public func composerLabel(_ target: ComposerTarget, in entry: FeedEntry) -> String {
    guard case .reply = target else { return "Reply to feed item" }
    guard let comment = replyTarget(target, in: entry), let username = comment.username else {
      return "Reply target unavailable."
    }
    return "Replying to @\(username)"
  }

  public func canPost(_ target: ComposerTarget, in entry: FeedEntry) -> Bool {
    guard draft(for: target).isPostable, state(of: target) != .saving else { return false }
    if case .reply = target { return replyTarget(target, in: entry) != nil }
    return true
  }

  // Posts the draft, clears it unless the member changed it meanwhile, and
  // reads the screen again. A posted reply opens its group.
  public func post(_ target: ComposerTarget, in entry: FeedEntry) async {
    guard canPost(target, in: entry) else { return }
    let draft = draft(for: target)
    let replyTo = replyTarget(target, in: entry)
    composerStates[target] = .saving
    do throws(APIError) {
      _ = try await api.send(
        .comment(
          conversation: entry.id,
          body: draft.body,
          spoiler: draft.spoiler,
          replyTo: replyTo?.id
        )
      )
    } catch {
      composerStates[target] = .failed(error.explanation)
      return
    }
    if let replyTo {
      threads[entry.id, default: ThreadState()].groups[replyTo.rootId ?? replyTo.id] = .expanded
    }
    if drafts[target] == draft { drafts[target] = CommentDraft() }
    composerStates[target] = .idle
    await refresh()
  }

  // MARK: - Reactions

  public func state(of target: ReactionTarget) -> WriteState {
    reactionStates[target] ?? .idle
  }

  // React opens or closes the seven reactions beneath its line.
  public func togglePicker(for target: ReactionTarget) {
    reactionPicker = reactionPicker == target ? nil : target
  }

  // Sets the reader's one reaction, or removes it when they choose the one
  // they already chose.
  public func react(
    _ kind: ReactionKind,
    to target: ReactionTarget,
    summary: [ReactionSummary]
  ) async {
    guard state(of: target) != .saving else { return }
    let chosen = summary.contains { $0.kind == kind && $0.reacted }
    reactionStates[target] = .saving
    do throws(APIError) {
      _ = try await api.send(
        .reaction(item: target.entry, reply: target.reply, kind: chosen ? nil : kind)
      )
    } catch {
      reactionStates[target] = .failed(error.explanation)
      return
    }
    reactionStates[target] = .idle
    if reactionPicker == target { reactionPicker = nil }
    await refresh()
  }

  // MARK: - Removals

  public func failure(for place: FeedPlace) -> String? { failures[place] }

  // Whether the reader can delete their own live comment, or remove another
  // member's from their own entry.
  public func removal(of comment: Comment, in item: FeedItem, viewer: String) -> Removal? {
    guard comment.isLive else { return nil }
    if comment.authorId == viewer { return .delete }
    return item.ownerId == viewer ? .remove : nil
  }

  public func askToRemove(_ comment: Comment, in item: FeedItem, viewer: String) {
    guard let removal = removal(of: comment, in: item, viewer: viewer) else { return }
    confirmation = .removeComment(comment, removal)
  }

  // An author deletes their own live comment or post entry.
  public func canDelete(_ item: FeedItem, viewer: String) -> Bool {
    item.isDeletable && item.active && item.ownerId == viewer
  }

  public func askToDelete(_ item: FeedItem) {
    confirmation = .deleteEntry(item)
  }

  // Runs the confirmed action, which the dialog passes since dismissing it
  // clears `confirmation`. A failure shows beneath the control that asked.
  public func confirm(_ confirmation: FeedConfirmation) async {
    if self.confirmation == confirmation { self.confirmation = nil }
    switch confirmation {
    case .deleteEntry(let item):
      await remove(id: item.id, place: .entry(item.id))
    case .removeComment(let comment, _):
      await remove(id: comment.id, place: .comment(comment.id))
    case .leaveTopTen(.withdraw, let item):
      await saveActivity(item, .recommended, value: false)
    case .leaveTopTen(.switchToWantToWatch, let item):
      await saveWantToWatch(item)
    }
  }

  private func remove(id: String, place: FeedPlace) async {
    failures[place] = nil
    do throws(APIError) {
      _ = try await api.send(.removeComment(id: id))
    } catch {
      failures[place] = error.explanation
      return
    }
    await refresh()
  }

  // MARK: - Title actions

  // Recommends a friend's entry's title, or withdraws the reader's
  // Recommend, asking first when that takes the title out of their top 10.
  public func toggleRecommend(_ item: FeedItem) async {
    if item.isRankedByViewer, let title = item.title, let rank = item.viewerTopTenRank {
      confirmation = .leaveTopTen(.withdraw(name: title.name, rank: rank), item)
      return
    }
    await saveActivity(item, .recommended, value: !item.viewerRecommended)
  }

  // Saves the title to Want to watch or removes it. Saving withdraws a
  // ranked Recommend, so that asks first.
  public func toggleWantToWatch(_ item: FeedItem) async {
    if item.isRankedByViewer, !item.viewerWantToWatch, let title = item.title,
      let rank = item.viewerTopTenRank
    {
      confirmation = .leaveTopTen(.switchToWantToWatch(name: title.name, rank: rank), item)
      return
    }
    await saveWantToWatch(item)
  }

  private func saveWantToWatch(_ item: FeedItem) async {
    let surface: SaveSurface =
      item.itemType == .recommended && item.active ? .friendRecommendation : .friendEntry
    await saveActivity(item, .wantToWatch, value: !item.viewerWantToWatch, surface: surface)
  }

  private func saveActivity(
    _ item: FeedItem,
    _ activity: TitleActivity,
    value: Bool,
    surface: SaveSurface? = nil
  ) async {
    guard titleActions == .idle, let title = item.title else { return }
    titleActions = .saving
    failures[.entry(item.id)] = nil
    defer { titleActions = .idle }
    do throws(APIError) {
      _ = try await api.send(.activity(title: title.id, activity, value: value, surface: surface))
    } catch {
      failures[.entry(item.id)] = error.explanation
      return
    }
    await refresh()
  }
}
