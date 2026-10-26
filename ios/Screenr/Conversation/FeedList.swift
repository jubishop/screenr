import ScreenrKit
import SwiftUI

// The interactive feed that the friends feed, title pages, and profiles
// share: a scrolling list of entries with their discussions, beneath the
// screen's own header. Other people's new activity waits behind New activity,
// which shows it without moving the entry at the top of the screen; a
// permalink's entry or reply scrolls into view highlighted; and destructive
// actions ask first. The screen keeps `feed` across reads, since a failed
// read replaces this view.
struct FeedList<Header: View>: View {
  let feed: FeedModel
  let snapshot: [FeedItem]
  let viewer: Person
  // The entry, and optionally reply, a permalink opened, as the screen
  // confirmed it.
  var target: LinkTarget?
  var targetUnavailable = false
  var style = EntryStyle.full
  // Shown while no entry is, or nil for nothing.
  var emptyMessage: String?
  // Scrolls back to the header each time it changes, such as when Start a
  // conversation opens its composer there.
  var headerRequests = 0
  // Shows and scrolls to an entry the screen names, such as a friend on a
  // title page's friend line, accepting waiting activity if it needs to.
  var entryRequest: EntryRequest?
  @ViewBuilder var header: () -> Header

  @State private var scrolled: FeedScrollTarget?
  @State private var pendingReply: String?
  // The entry at the top of the screen once the reader scrolls, which stays
  // where it is when New activity, or any other change, adds or moves entries
  // above it.
  @State private var position = ScrollPosition(idType: FeedScrollTarget.self)
  @State private var report = ScrollReport()

  var body: some View {
    let layout = feed.layout(snapshot, viewer: viewer.userId)
    let scrollTarget = feed.scrollTarget(target, in: layout)
    ScrollViewReader { proxy in
      ScrollView {
        // Times such as "2h" read the minute from here, since an unchanged
        // screen does not render again.
        TimelineView(.everyMinute) { context in
          VStack(alignment: .leading, spacing: 0) {
            Color.clear
              .frame(height: 0)
              .id(Top())
            header()
            if targetUnavailable {
              Label("This activity is unavailable.", systemImage: "exclamationmark.circle")
                .foregroundStyle(.muted)
                .padding()
            }
            // Entries are the only scroll targets, so the place the scroll
            // position keeps is never the header.
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(layout.entries) { entry in
                VStack(alignment: .leading, spacing: 0) {
                  EntryView(
                    feed: feed,
                    entry: entry,
                    viewer: viewer.userId,
                    style: style,
                    targetReply: target?.item == entry.id ? target?.reply : nil,
                    highlighted: target?.item == entry.id && target?.reply == nil
                  )
                  Divider()
                }
                .id(FeedScrollTarget.entry(entry.id))
              }
            }
            .scrollTargetLayout()
            .onGeometryChange(for: FeedStart.self) { proxy in
              proxy.frame(in: .named(FeedContent())).minY < 1 ? .entries : .header
            } action: {
              report.start = $0
            }
            if layout.entries.isEmpty, let emptyMessage {
              Text(emptyMessage)
                .foregroundStyle(.muted)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(32)
            }
          }
          .coordinateSpace(.named(FeedContent()))
          .environment(\.feedNow, context.date)
        }
      }
      .scrollPosition($position, anchor: .top)
      // Any part of an entry on screen counts.
      .onScrollTargetVisibilityChange(idType: FeedScrollTarget.self, threshold: 0.001) {
        report.visible = Set($0)
      }
      .scrollDismissesKeyboard(.interactively)
      .environment(
        \.pendingReplyScroll,
        PendingReplyScroll(comment: pendingReply) { comment in
          pendingReply = nil
          withAnimation {
            position.scrollTo(id: FeedScrollTarget.comment(comment), anchor: .center)
          }
        }
      )
      .incomingActivity(.activity, count: layout.incoming) {
        keepPlace(in: layout)
        feed.showIncoming(snapshot, viewer: viewer.userId)
      }
      .onChange(of: snapshot, initial: true) { _, snapshot in
        feed.receive(snapshot, viewer: viewer.userId)
      }
      .onChange(of: scrollTarget, initial: true) { _, target in
        scroll(to: target, in: layout, proxy)
      }
      .onChange(of: headerRequests) {
        // The header, rather than an entry, is now the reader's place.
        position = ScrollPosition(idType: FeedScrollTarget.self)
        withAnimation { proxy.scrollTo(Top(), anchor: .top) }
      }
      .onChange(of: entryRequest) { _, request in
        guard let request else { return }
        feed.show(entry: request.entry, in: snapshot, viewer: viewer.userId)
        // The entry may join the list only as it renders again.
        Task {
          withAnimation {
            position.scrollTo(id: FeedScrollTarget.entry(request.entry), anchor: .top)
          }
        }
      }
    }
    .confirmationDialog(
      feed.confirmation?.message ?? "",
      isPresented: Binding(
        get: { feed.confirmation != nil },
        set: { presented in if !presented { feed.confirmation = nil } }
      ),
      titleVisibility: .visible,
      presenting: feed.confirmation
    ) { confirmation in
      Button(confirmation.action, role: .destructive) {
        Task { await feed.confirm(confirmation) }
      }
      Button("Cancel", role: .cancel) {}
    }
  }

  // Names the reader's place in `position` just before New activity shows.
  private func keepPlace(in layout: FeedLayout) {
    var first: FeedScrollTarget?
    if let entry = layout.entries.first { first = .entry(entry.id) }
    let anchor = FeedAnchor(
      named: position.viewID(type: FeedScrollTarget.self),
      visible: report.visible,
      first: first,
      start: report.start
    )
    switch anchor {
    case .kept: break
    case .pin(let entry): position.scrollTo(id: entry, anchor: .top)
    case .release: position = ScrollPosition(idType: FeedScrollTarget.self)
    }
  }

  // Moves to a permalink's entry once, and then to its reply when the reply
  // shows, such as after the reader reveals a spoiler discussion. A reply in
  // an entry the list has not loaded yet scrolls once its row appears.
  private func scroll(
    to target: FeedScrollTarget?,
    in layout: FeedLayout,
    _ proxy: ScrollViewProxy
  ) {
    guard let target, target != scrolled else { return }
    let first = scrolled == nil
    scrolled = target
    switch target {
    case .entry:
      withAnimation { position.scrollTo(id: target, anchor: .top) }
    case .comment(let comment):
      if first,
        let entry = layout.entries.first(where: { $0.comments.contains { $0.id == comment } })
      {
        proxy.scrollTo(FeedScrollTarget.entry(entry.id), anchor: .top)
      }
      pendingReply = comment
      withAnimation { position.scrollTo(id: target, anchor: .center) }
    }
  }
}

extension FeedList where Header == EmptyView {
  init(
    feed: FeedModel,
    snapshot: [FeedItem],
    viewer: Person,
    target: LinkTarget? = nil,
    targetUnavailable: Bool = false,
    style: EntryStyle = .full,
    emptyMessage: String? = nil
  ) {
    self.init(
      feed: feed,
      snapshot: snapshot,
      viewer: viewer,
      target: target,
      targetUnavailable: targetUnavailable,
      style: style,
      emptyMessage: emptyMessage,
      headerRequests: 0
    ) { EmptyView() }
  }
}

// The header's place in the scroll view.
private struct Top: Hashable {}

// The coordinate space of the feed's content, header and all.
private nonisolated struct FeedContent: Hashable, Sendable {}

// What the scroll view reports as the reader scrolls, held outside the view's
// state so that scrolling does not render the feed again.
private final class ScrollReport {
  var visible: Set<FeedScrollTarget> = []
  var start = FeedStart.entries
}

// A screen's request to show one entry. Each request scrolls, even to the
// entry the last one showed.
struct EntryRequest: Hashable {
  let entry: String
  private let request = UUID()

  init(entry: String) {
    self.entry = entry
  }
}

// The reply a permalink names, which the list scrolls to when its row
// appears, since a lazily loaded entry's replies are unknown until then.
struct PendingReplyScroll {
  let comment: String?
  let scroll: (String) -> Void
}

extension EnvironmentValues {
  @Entry var pendingReplyScroll: PendingReplyScroll?
  // The current minute, for the feed's relative times.
  @Entry var feedNow = Date.now
}
