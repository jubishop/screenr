import ScreenrKit
import SwiftUI

// One comment in a discussion: its author, time, the person it answers, and
// its text, behind a reveal when it is a spoiler. A removed comment keeps its
// place as "Comment removed", and an unavailable one, such as a blocked
// member's, shows no author or text. Live comments have Reply, Delete or
// Remove, and reactions.
struct CommentView: View {
  let feed: FeedModel
  let comment: Comment
  let entry: FeedEntry
  let viewer: String
  // The comment a permalink names, which shows highlighted.
  var highlighted = false
  @Environment(\.pendingReplyScroll) private var pendingScroll
  @Environment(\.feedNow) private var now

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      heading
      if !comment.unavailable, let addressed = comment.addressedUsername {
        Text("Replying to @\(addressed)")
          .font(.footnote)
          .foregroundStyle(.muted)
      }
      content
      if comment.isLive {
        actions
        ReactionPicker(
          feed: feed,
          target: ReactionTarget(entry: entry.id, reply: comment.id),
          summary: comment.reactions
        )
        WriteFailure(message: feed.failure(for: .comment(comment.id)))
        WriteFailure(
          message: feed.state(of: ReactionTarget(entry: entry.id, reply: comment.id)).failure
        )
      }
    }
    .padding(.vertical, 6)
    .padding(.horizontal, highlighted ? 8 : 0)
    .background {
      if highlighted {
        RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.12))
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("comment-\(comment.id)")
    .id(FeedScrollTarget.comment(comment.id))
    .onAppear {
      if let pendingScroll, pendingScroll.comment == comment.id { pendingScroll.scroll(comment.id) }
    }
  }

  private var heading: some View {
    HStack(alignment: .center, spacing: 8) {
      if let member = Avatar.Member(comment), let username = comment.username {
        NavigationLink(value: Destination.profile(username: username)) {
          HStack(spacing: 8) {
            Avatar(member, size: 28)
            VStack(alignment: .leading, spacing: 0) {
              Text(member.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
              Text("@\(username)")
                .font(.footnote)
                .foregroundStyle(.muted)
            }
          }
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
          "\(member.name), @\(username), \(RelativeTime.fullDate(comment.createdAt))"
        )
      } else {
        Avatar(nil, size: 28)
        Text(comment.hasDeletedAuthor ? "Comment removed" : "Comment unavailable")
          .font(.subheadline)
          .foregroundStyle(.muted)
      }
      Spacer(minLength: 0)
      if !comment.unavailable {
        // The author's link reads the full time.
        Text(RelativeTime.label(comment.createdAt, now: now))
          .font(.footnote)
          .foregroundStyle(.muted)
          .accessibilityHidden(true)
      }
    }
  }

  @ViewBuilder private var content: some View {
    if comment.unavailable || comment.hasDeletedAuthor {
      EmptyView()
    } else if comment.removed {
      Text("Comment removed")
        .foregroundStyle(.muted)
    } else if feed.isHidden(comment) {
      Button {
        feed.reveal(comment)
      } label: {
        Label("Contains spoilers · Reveal comment", systemImage: "eye.slash")
      }
      .buttonStyle(.feedAction)
    } else {
      Text(comment.body)
        .textSelection(.enabled)
    }
  }

  private var actions: some View {
    FlowLayout {
      Button {
        feed.open(.reply(entry: entry.id, comment: comment.id))
      } label: {
        Label("Reply", systemImage: "arrowshape.turn.up.left")
      }
      if let removal = feed.removal(of: comment, in: entry.item, viewer: viewer) {
        Button(role: .destructive) {
          feed.askToRemove(comment, in: entry.item, viewer: viewer)
        } label: {
          Label(removal.label, systemImage: "trash")
        }
      }
      if !feed.isHidden(comment) {
        ReactionControls(
          feed: feed,
          target: ReactionTarget(entry: entry.id, reply: comment.id),
          summary: comment.reactions
        )
      }
    }
    .labelStyle(.titleAndIcon)
    .buttonStyle(.feedAction)
  }
}
