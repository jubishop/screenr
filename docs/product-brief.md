---
status: planning
---

# Product brief

Screenr is a social app for TV and movies, centered on people you know.

## Confirmed requirements

- Friendships require a request and acceptance. One-way following is not
  supported.
- Users can see what their friends are watching or recommend.
- Users can make their own recommendations.
- Users can contribute to discussion threads about any show.
- Users can add their own reviews and comments.
- Posts, reviews, and discussion threads are visible to their author and the
  author's direct friends. Only that group can comment.
- Participants can see comments on a mutual friend's content, subject to
  blocking. Friends of friends become visible as fellow commenters; this
  does not grant access to their own posts, reviews, or threads.
- Ending a friendship immediately removes both users' access to each other's
  existing posts, reviews, and threads.
- Unfriending also automatically hides each person's existing comments on
  content owned by the other person.
- Accepting a new friendship restores comments hidden by the earlier
  unfriending.
- Blocking ends any friendship, prevents new friend requests between the
  pair, and hides their content from each other, including comments on
  mutual friends' posts.
- Global discovery and global publishing are outside the product's scope.

## Accepted decisions

### Core experience — 2026-09-04

**Decision:** Help users discover what to watch through people they know,
and participate through discussions, reviews, comments, and recommendations.

**Why:** The user emphasized existing social connections and contributing to
conversations. This refines the earlier proposed focus on recommendations
from "people I trust."

### Product social scope — 2026-09-04

**Decision:** Center Screenr on direct friends, with friends of friends
visible through conversations on a mutual friend's content. Global discovery
and globally published recommendations are explicitly out of scope.

**Why:** Other apps already cover global discovery. Screenr is about the
user's personal social circle and one layer deeper. The content audience
rules below define how that second layer becomes visible.

This supersedes the initial proposal for optional global discovery and
global visibility controls, including the later suggestion to defer them.
They are not planned future features.

### Mutual friendships — 2026-09-04

**Decision:** A friendship exists only after one user requests it and the
other accepts. Pending requests do not establish friendships. Screenr does
not support one-way following.

Friends of friends are reached through two accepted friendships. The direct
friend and friend-of-friend groups exclude the user themselves.

**Why:** The user requires both people to agree to the friendship. Accepted
friendships therefore define the social circle and its next layer.

### Content audiences and comment visibility — 2026-09-04

**Decision:** A post, review, or discussion thread is visible only to its
author and that author's direct, accepted friends. Only those people can
comment. Every eligible participant can see all comments from the author and
the author's current friends, including people who are not their own direct
friends, subject to the blocking rules below. The unfriending rules also
apply to historical comments.

Friends of friends are visible through comments on a mutual friend's
content. They do not get direct access to each other's own posts, reviews,
or threads without becoming friends.

**Why:** All participants are friends of the original author. Any two
participants are therefore direct friends or friends of friends through that
author. This preserves complete conversations within the personal-circle
boundary without an exception for more distant people.

For example, Alice is friends with Ben and Cam, who are not friends with
each other. Ben and Cam can both read Alice's thread and all its comments,
and contribute there. That does not give Ben access to Cam's own posts.

This replaces the previously accepted friends-of-friends default audience
and per-item Friends-only option. The audience for these content types is
now fixed to the author and direct friends.

### Access after unfriending — 2026-09-04

**Decision:** Access follows current accepted friendships. When a friendship
ends, both users immediately lose access to each other's existing posts,
reviews, and discussion threads. Past participation does not preserve access.

**Why:** The user accepted this rule so that Friends-only access stays
consistent for older content after a friendship ends.

### Existing comments after unfriending — 2026-09-04

**Decision:** When a friendship ends, automatically hide each person's
existing comments on posts, reviews, and threads owned by the other person.
Those comments are hidden from the content's author and its remaining
audience. Unfriending hides the comments; it does not delete them.

**Why:** The user accepted this rule to keep visible commenters within the
content author's current friend circle.

### Comments after restoring a friendship — 2026-09-04

**Decision:** If the two users later request and accept a new friendship,
comments hidden because of the earlier unfriending become visible again.

**Why:** The user accepted this rule so that comment visibility follows the
current friendship, just like access to posts.

### Blocking — 2026-09-04

**Decision:** Blocking ends any friendship between the two people and
prevents new friend requests between them while the block is active. Each
person's content is hidden from the other, including comments on posts,
reviews, and threads owned by mutual friends.

Other eligible participants in those mutual friends' conversations can
still see both people's comments. Blocking is therefore an explicit
exception to participants seeing the same conversation. Ending a friendship
also applies the existing unfriending rules to comments on the pair's own
content.

**Why:** The user accepted blocking that also applies within shared
conversations, while preserving those comments for other participants.

## Open decisions

- Launch platform and application stack.
- The initial group of users and how they find people they know.
- Watch statuses, watch history, and TV season or episode tracking.
- Recommendation format, ratings, and spoiler handling.
- Thread structure and the relationship between reviews, recommendations,
  and comments.
- Visibility rules for watch activity, profiles, and other content beyond
  posts, reviews, and discussion threads.
- Feed ordering, notifications, reporting, and moderation within the network.
- Movie and TV metadata source, authentication, and hosting.
- The detailed first-release scope and how to judge its success.
