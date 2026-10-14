import ScreenrKit
import SwiftUI

// One feed entry: its poster and title, the author's action and time, any
// season label, rating, and text, then its actions and its discussion. A
// spoiler hides the text, reactions, and discussion until the reader reveals
// them; the label and rating stay outside the cover. Compact entries, on
// title pages, leave the title's details and actions to the page header.
struct EntryView: View {
  let feed: FeedModel
  let entry: FeedEntry
  let viewer: String
  var style = EntryStyle.full
  // The reply a permalink names in this entry, or nil.
  var targetReply: String?
  // Whether a permalink names this entry, which then shows highlighted.
  var highlighted = false

  @Environment(\.feedNow) private var now

  private var item: FeedItem { entry.item }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 12) {
        if style == .full, let title = item.title {
          // The title link beside it names the same page for VoiceOver.
          NavigationLink(value: title.destination) {
            PosterImage(path: item.posterPath, name: title.name)
          }
          .buttonStyle(.plain)
          .accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: 6) {
          byline
          if style == .full, let title = item.title {
            NavigationLink(value: title.destination) {
              VStack(alignment: .leading, spacing: 2) {
                Text(title.name)
                  .font(.headline)
                  .multilineTextAlignment(.leading)
                Text(title.details)
                  .font(.footnote)
                  .foregroundStyle(.muted)
              }
              .frame(minHeight: 44)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
          }
          details
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      actions
      ReactionPicker(feed: feed, target: ReactionTarget(entry: item.id), summary: item.reactions)
      WriteFailure(message: feed.failure(for: .entry(item.id)))
      WriteFailure(message: feed.state(of: ReactionTarget(entry: item.id)).failure)
      if !feed.isHidden(item) {
        ThreadView(feed: feed, entry: entry, viewer: viewer, targetReply: targetReply)
      }
    }
    .padding()
    .background {
      if highlighted { Color.accentColor.opacity(0.12) }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("entry-\(item.id)")
  }

  // The author, linked to their profile, and what they did when.
  private var byline: some View {
    NavigationLink(value: Destination.profile(username: item.username)) {
      HStack(alignment: .center, spacing: 8) {
        Avatar(Avatar.Member(item))
        VStack(alignment: .leading, spacing: 0) {
          Text(item.displayName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
          // One wrapping line, such as "finished · Oct 12 · 2h · Edited".
          Text(
            activity(at: RelativeTime.label(entry.visibleActivity, now: now))
              .joined(separator: " · ")
          )
          .font(.subheadline)
          .foregroundStyle(.muted)
          .multilineTextAlignment(.leading)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(
      ([item.displayName] + activity(at: RelativeTime.fullDate(entry.visibleActivity)))
        .joined(separator: ", ")
    )
  }

  // What the author did, when, and whether they edited it since.
  private func activity(at time: String) -> [String] {
    [item.action(style: style), time] + (item.edited ? ["Edited"] : [])
  }

  @ViewBuilder private var details: some View {
    if let label = item.discussionLabel {
      Text(label)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Color.accentColor.opacity(0.15), in: Capsule())
    }
    if let removed = item.removedLabel {
      Text(removed)
        .foregroundStyle(.muted)
    }
    if let rating = item.rating {
      Text(ReviewStars.symbols(rating))
        .foregroundStyle(.tint)
        .accessibilityLabel("Rating")
        .accessibilityValue(ReviewStars.value(rating))
    }
    if feed.isHidden(item) {
      Button {
        feed.reveal(item)
      } label: {
        Label("Contains spoilers · Reveal discussion", systemImage: "eye.slash")
      }
      .buttonStyle(.feedAction)
    } else if let body = item.body, !body.isEmpty {
      Text(body)
        .textSelection(.enabled)
    }
  }

  // Delete for the author's comment or post; Want to watch and Recommend on
  // a friend's entry; reactions unless the spoiler cover or a removal hides
  // them; and sharing the entry's link.
  private var actions: some View {
    FlowLayout {
      if feed.canDelete(item, viewer: viewer) {
        Button(role: .destructive) {
          feed.askToDelete(item)
        } label: {
          Label("Delete", systemImage: "trash")
        }
      }
      if style == .full, let title = item.title, item.ownerId != viewer {
        TitleActionButtons(feed: feed, item: item, title: title)
      }
      if !feed.isHidden(item), !item.isErased {
        ReactionControls(
          feed: feed,
          target: ReactionTarget(entry: item.id),
          summary: item.reactions
        )
      }
      ShareButton(destination: item.link(), subject: item.title?.name ?? "A post on Screenr")
        .labelStyle(.iconOnly)
        .accessibilityLabel("Share link to discussion")
    }
    .buttonStyle(.feedAction)
  }
}

// Want to watch and Recommend on a friend's entry. A reader with another
// status sees it, linked to the title page, instead of Want to watch.
private struct TitleActionButtons: View {
  let feed: FeedModel
  let item: FeedItem
  let title: EntryTitle

  var body: some View {
    let saving = feed.titleActions == .saving
    if let status = item.viewerStatus, status != .wantToWatch, status != .unknown {
      NavigationLink(value: title.destination) {
        Label(status.label, systemImage: "checkmark")
      }
      .accessibilityHint("Opens \(title.name) to change your status.")
    } else {
      Button {
        Task { await feed.toggleWantToWatch(item) }
      } label: {
        Label("Want to watch", systemImage: item.viewerWantToWatch ? "checkmark" : "plus")
      }
      .buttonStyle(.feedAction(chosen: item.viewerWantToWatch))
      .disabled(saving)
      .accessibilityAddTraits(item.viewerWantToWatch ? .isSelected : [])
    }
    Button {
      Task { await feed.toggleRecommend(item) }
    } label: {
      Label(
        item.viewerRecommended ? "Recommended" : "Recommend",
        systemImage: item.viewerRecommended ? "checkmark" : "plus"
      )
    }
    .buttonStyle(.feedAction(chosen: item.viewerRecommended))
    .disabled(saving)
    .accessibilityAddTraits(item.viewerRecommended ? .isSelected : [])
  }
}
