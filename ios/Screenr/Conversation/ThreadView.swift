import ScreenrKit
import SwiftUI

// An entry's discussion: the reply count, Show earlier comments, the direct
// comments, each with its group of nested replies behind View N replies, and
// Comment, which opens the composer for the entry itself. Reply opens a
// composer beneath its comment.
struct ThreadView: View {
  let feed: FeedModel
  let entry: FeedEntry
  let viewer: String
  // The reply a permalink names, which shows its whole discussion.
  let targetReply: String?

  var body: some View {
    let thread = feed.thread(entry, targetReply: targetReply)
    VStack(alignment: .leading, spacing: 8) {
      if !entry.comments.isEmpty {
        Text(thread.replyCount == 1 ? "1 reply" : "\(thread.replyCount) replies")
          .font(.footnote)
          .foregroundStyle(.muted)
      }
      if case .hidden(let live) = thread.earlier {
        Button(live > 0 ? "Show earlier comments (\(live))" : "Show earlier comments") {
          feed.showEarlier(in: entry.id)
        }
        .buttonStyle(.feedText)
      }
      ForEach(thread.groups) { group in
        groupView(group)
      }
      if let orphan = orphanedReply(in: thread) {
        DiscussionComposer(feed: feed, target: orphan, entry: entry)
      }
      Button {
        feed.open(.entry(entry.id))
      } label: {
        Label("Comment", systemImage: "bubble.left")
      }
      .buttonStyle(.feedAction)
      if feed.isOpen(.entry(entry.id)) {
        DiscussionComposer(feed: feed, target: .entry(entry.id), entry: entry)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Conversation")
  }

  @ViewBuilder
  private func groupView(_ group: ThreadLayout.Group) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      CommentView(
        feed: feed,
        comment: group.parent,
        entry: entry,
        viewer: viewer,
        highlighted: group.parent.id == targetReply
      )
      composer(for: group.parent)
      if !group.replies.isEmpty {
        let count = group.replies.count
        let noun = count == 1 ? "reply" : "replies"
        Button {
          feed.toggle(group, in: entry.id)
        } label: {
          Label(
            group.disclosure == .expanded ? "Hide \(count) \(noun)" : "View \(count) \(noun)",
            systemImage: group.disclosure == .expanded ? "chevron.up" : "chevron.down"
          )
        }
        .buttonStyle(.feedText)
        .accessibilityValue(group.disclosure == .expanded ? "Expanded" : "Collapsed")
        if group.disclosure == .expanded {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(group.replies) { reply in
              CommentView(
                feed: feed,
                comment: reply,
                entry: entry,
                viewer: viewer,
                highlighted: reply.id == targetReply
              )
              composer(for: reply)
            }
          }
          .padding(.leading, 14)
          .overlay(alignment: .leading) {
            // Connects the nested replies to the comment they answer.
            Rectangle()
              .fill(.separator)
              .frame(width: 2)
              .accessibilityHidden(true)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func composer(for comment: Comment) -> some View {
    let target = ComposerTarget.reply(entry: entry.id, comment: comment.id)
    if feed.isOpen(target) {
      DiscussionComposer(feed: feed, target: target, entry: entry)
    }
  }

  // A reply composer whose comment no longer shows, such as an earlier or
  // removed one, stays at the end with its draft.
  private func orphanedReply(in thread: ThreadLayout) -> ComposerTarget? {
    guard let target = feed.openReply(in: entry.id),
      case .reply(_, let comment) = target
    else { return nil }
    let shown = thread.groups.contains { group in
      group.parent.id == comment || group.replies.contains { $0.id == comment }
    }
    return shown ? nil : target
  }
}
