---
status: current
---

# Product brief

Screenr is a social app for TV and movies, centered on people you know.

## Confirmed requirements

- The first release is a mobile-friendly web app for phone and computer browsers.
- Launch is invite-only, starting with the user and a small group of friends.
  Each member can invite people they know.
- Friendships require a request and acceptance. One-way following is not
  supported.
- People can find friends through shareable profile links, exact-username
  search, and a friend-request action on commenters in mutual friends' threads.
- Profiles require sign-in. People who are not accepted friends see only a
  display name, username, photo, and friend-request button, subject to blocking.
- Watch activity, ratings, reviews, and recommendations are visible to their
  owner and the owner's current accepted friends.
- Users can see what their friends are watching or recommend.
- Each movie or show has a standalone page, with all eligible conversations
  hosted by the user or their direct friends shown below the title details.
  People views and title views open the same conversations. Title pages put
  conversations with the most recent visible activity first.
- The friends feed automatically includes watch-status changes and ratings,
  alongside reviews, recommendations, and discussion posts, newest first.
  Changes made together by one person for the same title form one update.
- Notifications cover friend requests and acceptances, comments on the
  user's posts or reviews, and replies to their comments. Watch updates,
  ratings, and recommendations appear in the feed without alerts.
- Deliver activity notifications through an in-app inbox and opt-in email
  alerts. Browser push is outside the initial release.
- TV watch progress is tracked for each show as a whole, using simple statuses.
- Movies and shows support Want to watch, Watching, Finished, and Stopped
  watching. TV also supports a manually selected Caught up status.
- Each tracked title has one current status and an optional last-finished
  date. A diary of separate viewings is outside the initial release.
- Users can make their own recommendations.
- A dedicated Friends recommend view shows titles recommended by direct
  friends, who recommends each title, and an Add to Want to watch action.
- Friends recommend sorts by the number of recommending friends, then the
  most recent recommendation. It has a Movies/TV filter and hides Finished
  titles by default, with a switch to show them.
- Users can contribute to discussion threads about any show.
- TV discussion posts can optionally identify a season or episode. The
  label is visible before revealing spoilers; reviews, ratings, and watch
  tracking remain at show level.
- Discussion posts can also have no movie or show attached. Reviews and
  Recommend actions always belong to a specific title.
- Users can add their own reviews and comments.
- Discussions support replies to individual comments, grouped beneath the
  original comment with one level of nesting and the addressed person shown.
- Post and review authors can remove comments from conversations they host.
  Replies remain under a Comment removed placeholder when their parent
  comment is removed.
- Administrator reporting, review queues, and account suspensions are
  outside the initial release.
- Ratings use whole stars from 1 to 5. Ratings and written review text are
  independently optional: users can provide either or both.
- Each person has one editable review and rating per movie or show. Separate
  discussion posts can start new conversations about the same title.
- Each person's watch status, rating, review, and recommendation for a title
  share one comment thread. Separate discussion posts have their own threads.
- Authors can mark reviews, posts, and comments as containing spoilers.
  Marked text stays hidden until the reader chooses to reveal it and is
  excluded from notification previews. A flag on a post or review covers
  its entire comment thread.
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

### Launch platform — 2026-09-04

**Decision:** Launch as a mobile-friendly web app that people can use from
their phones or computers through a browser.

**Why:** The user accepted this approach so that friends can join through a
link across different devices. Bringing a whole friend group into the app
is central to its purpose.

The application stack and features such as installation or offline support
have not been selected.

### Invite-only launch — 2026-09-04

**Decision:** Make the first release invite-only, starting with the user
and a small group of friends. Each member can invite people they know.
Invitations provide access to join the app; friendships still require the
existing request-and-acceptance process.

**Why:** The user accepted starting with overlapping friend circles to test
the core experience.

### TV watch tracking — 2026-09-04

**Decision:** Track TV shows as a whole in the first release, using simple
watch statuses. Individual season or episode progress tracking is outside
the initial release's scope.

**Why:** The user accepted this approach to keep updates quick while giving
friends useful context about what someone is watching.

This decision concerns watch progress; it does not set the scope of review
or discussion topics.

### Watch statuses — 2026-09-04

**Decision:** Support Want to watch, Watching, Finished, and Stopped watching
for both movies and TV shows. TV shows also support Caught up. Users select
Caught up manually to say they are waiting for more episodes; it does not
require tracking individual episodes.

**Why:** The user accepted this status set, including a way to distinguish
watching a show from waiting for more episodes.

### Watch history at launch — 2026-09-04

**Decision:** Keep one current status per tracked title and an optional date
when the user last finished it. Users can move a title back to Watching for
a rewatch. A diary with separate entries for every viewing is outside the
initial release.

**Why:** The user accepted this limited watch-history scope for the first
release, including a way to reflect a rewatch through the current status.

### Ratings and written reviews — 2026-09-04

**Decision:** Support optional whole-star ratings from 1 to 5 and optional
written review text. A user can leave a rating without text, write a review
without a rating, or provide both.

**Why:** The user accepted a format that supports both quick ratings and
more detailed written opinions.

### Recommendations — 2026-09-04

**Decision:** Provide an explicit Recommend action, separate from the star
rating. A user can recommend a title to their friends without rating it or
writing a review. Ratings do not automatically become recommendations.

**Why:** The user accepted this approach so that recommending a title is a
deliberate choice, independent of a rating or written opinion.

### Friends recommend view — 2026-09-04

**Decision:** Provide a dedicated "Friends recommend" view showing titles
the user's direct friends recommend, who recommends each title, and an
"Add to Want to watch" action. Apply the existing friendship and blocking
rules. This view keeps recommendations accessible after they have passed
through the activity feed.

**Why:** The user accepted a dedicated place to find friends' recommendations
that remains useful beyond the activity feed.

### Recommendation ordering and filters — 2026-09-04

**Decision:** Sort the Friends recommend view by how many of the user's
current direct friends recommend each title, highest count first. Break ties
using the most recent recommendation from those friends, newest first.
Apply the existing blocking rules to these counts and dates.

Provide a Movies/TV filter. Hide titles the user has marked Finished by
default, with a switch to show them.

**Why:** The user accepted the proposed ordering and filters; no additional
rationale was given.

### One editable review per title — 2026-09-04

**Decision:** Each person can have one review and one rating per movie or
show, and can edit them as their opinion changes. Rating and review text
remain independently optional. Users can create separate discussion posts
to start new conversations about the same title.

**Why:** The user accepted one review that can evolve over time, with
separate discussion posts for new thoughts and conversations.

### Shared conversation per person and title — 2026-09-04

**Decision:** Use one shared comment thread for a person's watch status,
rating, review, and recommendation for a title. Adding or updating those
fields continues the same conversation. For example, recommending a show
and later adding a review keeps friends' comments together.

Each separate discussion post retains its own thread. The shared thread
follows the existing audience, blocking, spoiler, author comment-removal,
and notification rules for conversations.

**Why:** The user accepted keeping the conversation together as someone
adds or updates their activity and opinions about a title.

### Standalone movie and show pages — 2026-09-04

**Decision:** Give each movie or show its own standalone page. Show the
title details first, with all eligible conversations about that title below.
Include shared person-and-title threads and separate discussion posts
attached to the title. A show's page also includes discussions labelled for
its seasons or episodes.

People views and title views open the same conversations. Each viewer's
conversation list includes their own threads and threads hosted by their
current direct friends, subject to the existing access, blocking, and
spoiler rules. A friend's comment on an otherwise inaccessible thread does
not grant access to that thread.

**Why:** The user wants to browse content through both people and movies or
shows, with all friends' conversations about a title available together.

### Conversation ordering on title pages — 2026-09-04

**Decision:** Order conversations on movie and show pages by recent visible
activity, newest first. New threads and new visible comments or replies
bring a conversation to the top. Activity hidden by the existing access or
blocking rules does not affect this ordering.

**Why:** The user accepted bringing recently active conversations to the
top of a title's page.

### Spoiler flags — 2026-09-04

**Decision:** Provide a simple "Contains spoilers" flag that authors can
apply to reviews, posts, and comments. Marked text stays hidden until the
reader chooses to reveal it. Do not include that text in notification
previews.

**Why:** The user accepted explicit reader control over revealing text
that its author has marked as containing spoilers.

### Spoilers in comment threads — 2026-09-04

**Decision:** A spoiler flag on a post or review covers its entire comment
thread. Revealing it opens the whole conversation for an eligible reader,
subject to the existing access and blocking rules. Reply text stays out of
notification previews. On an unmarked post or review, commenters can still
mark individual comments as containing spoilers.

**Why:** The user accepted a single reveal action for conversations whose
original post or review is marked as containing spoilers.

### Replies to comments — 2026-09-04

**Decision:** Support replies to individual comments. Display one level of
replies beneath each top-level comment. Replies to those replies remain in
the same group rather than adding more nesting. Show whom each reply
addresses.

**Why:** The user accepted grouped replies that keep conversations easy to
follow on a phone.

### Comment removal by the conversation's author — 2026-09-04

**Decision:** Let the author of a post or review remove comments from its
conversation. When a removed comment has replies, keep those replies under
a "Comment removed" placeholder. The remaining replies continue to follow
the existing access, blocking, and spoiler rules.

**Why:** The user accepted giving the author control over their conversation
while preserving the remaining replies.

### Administrator moderation deferred — 2026-09-04

**Decision:** Defer administrator reporting and moderation for now. The
proposed Report action, private administrator review queue, administrator
content removal, and account suspensions are outside the initial release.

**Scope interpretation:** This applies to the administrator workflow just
proposed. The previously accepted author comment-removal, unfriending, and
blocking controls remain in scope.

**Why:** The user asked to skip moderation for now; no further rationale
was stated.

### Discussions without an attached title — 2026-09-04

**Decision:** Let users start discussion posts without attaching a movie or
show. Reviews and Recommend actions still belong to a specific title. All
discussion posts follow the existing author-and-direct-friends audience
rules, whether or not they have a title attached.

**Why:** The user accepted general discussions so that friends can ask for
suggestions, such as "Any good comedies for tonight?"

### Season and episode discussion labels — 2026-09-04

**Decision:** Let TV discussion posts optionally identify a season or
episode, using a label such as "Season 2, Episode 4." Show that label before
the reader reveals spoiler content. For TV, reviews, ratings, and watch
tracking remain at show level.

**Why:** The user accepted these labels so friends can tell what part of a
show a conversation covers before revealing spoilers.

### Finding and adding friends — 2026-09-04

**Decision:** At launch, support shareable profile links, exact-username
search, and a friend-request action on people commenting in mutual friends'
threads. Each route uses the existing request-and-acceptance process and
respects blocking. Opening a profile link does not establish a friendship.

**Why:** The user accepted these ways to connect with people they know and
people they encounter in mutual friends' conversations, within the agreed
mutual-friendship model.

### Profile visibility before friendship — 2026-09-04

**Decision:** Require sign-in before showing a profile, including through
shared profile links. Signed-in users who are not accepted friends see only
the person's display name, username, photo, and friend-request button,
subject to the existing blocking rules.

Watch activity, ratings, reviews, and recommendations are visible to their
owner and the owner's current accepted friends. Viewing a profile or having
a pending friend request does not grant access to that content.

**Why:** The user accepted a minimal profile for finding friends while
keeping viewing activity and opinions within accepted friendships.

### Friends feed — 2026-09-04

**Decision:** Automatically include watch-status changes and ratings in the
friends feed, alongside reviews, recommendations, and discussion posts.
Order the feed newest first and apply the existing content audience and
blocking rules.

Combine changes made together by the same person for the same title into
one update. For example, finishing and rating a movie together produces one
feed item.

**Why:** The user accepted automatic activity updates with related changes
grouped together to avoid flooding the feed.

### Notification triggers — 2026-09-04

**Decision:** At launch, notify users about friend requests and acceptances,
comments on their posts or reviews, and replies to their comments. Watch
updates, ratings, and recommendations appear in the feed without generating
alerts. Notification visibility and previews follow the existing access,
blocking, and spoiler rules.

**Why:** The user accepted notifications focused on these interactions,
with routine viewing activity left in the feed.

### Notification delivery — 2026-09-04

**Decision:** Provide an in-app notification inbox and opt-in email alerts
for the agreed notification triggers. Activity email alerts remain off until
the user enables them. Browser push notifications are outside the initial
release.

**Why:** The user accepted email as a way to notice friend requests and
replies before checking Screenr becomes a habit.

## Open decisions

- Application stack.
- Onboarding.
- Movie and TV metadata source, authentication, and hosting.
- The detailed first-release scope and how to judge its success.
