---
status: current
---

# Product brief

Screenr is a social app for TV and movies, centered on people you know.

## Confirmed requirements

- The first release is a mobile-friendly web app for phone and computer browsers.
- Use the [selected application stack](application-stack.md).
- Host Screenr on a Hetzner VPS and operate its core services ourselves.
  Use Resend to deliver login codes and enabled email alerts.
- Launch is invite-only, starting with the user and a small group of friends.
  Each member can invite people they know.
- Screenr is a non-commercial experiment for now, with no ads or paid features.
- After sign-in, setup requires only a display name and username. A profile
  photo, sending a friend request to the inviter, and adding titles are optional.
- Support Google sign-in and one-time email codes, with invitation access
  required for both methods and no separate Screenr password.
- Friendships require a request and acceptance. One-way following is not
  supported.
- People can find friends through shareable profile links, exact-username
  search, accepted friend lists on profiles, and a friend-request action on
  commenters in mutual friends' threads.
- Profiles require sign-in. People who are not accepted friends see a
  display name, username, photo, friend-request button, and the person's
  accepted friends, subject to blocking.
- Watch activity, ratings, reviews, and recommendations are visible to their
  owner and the owner's current accepted friends.
- Users can see what their friends are watching or recommend.
- Each movie or show has a standalone page with one unified feed below
  the title details. The [title-feed decisions](title-feed.md) define its
  presentation and audience. Friends, profile, and title feeds show the
  same underlying entries and support viewing and replying inline.
- Use The Movie Database (TMDB) as the movie and TV catalog source.
- Show US at-home viewing options on movie and TV title pages, following
  the [title availability decisions](title-availability.md).
- The friends feed automatically includes watch-status changes and ratings,
  alongside reviews, recommendations, and discussion posts. The
  [shared feed rules](title-feed.md) define item identity, visibility,
  and ordering by recent visible activity.
- Notifications cover friend requests and acceptances, comments on the
  user's posts or reviews, and replies to their comments. Watch updates,
  ratings, and recommendations appear in the feed without alerts.
- Deliver activity notifications through an in-app inbox and opt-in email
  alerts. Browser push is outside the initial release.
- Judge initial success through usage telemetry: repeat use, choosing titles
  through friends' recommendations, and sustained conversations. Do not use
  user surveys to assess this.
- TV watch progress is tracked for each show as a whole, using simple statuses.
- Movies and shows support Want to watch, Watching, Finished, and Stopped
  watching. TV also supports a manually selected Caught up status.
- Each tracked title has one current status and an optional last-finished
  date. A diary of separate viewings is outside the initial release.
- Provide a Watch together link on an accepted friend's profile. It opens
  a dedicated page comparing the viewer's and friend's Want to watch choices
  to help them decide what to watch together. Start with a two-person
  interface and preserve implementation flexibility for more participants.
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
  direct comment with one additional level of nesting and the addressed
  person shown. A direct comment replies to the feed item itself; a nested
  reply appears indented beneath that comment.
- Post and review authors can remove comments from conversations they host.
  Replies remain under a Comment removed placeholder when their parent
  comment is removed.
- Administrator reporting, review queues, and account suspensions are
  outside the initial release.
- Ratings use whole stars from 1 to 5. Ratings and written review text are
  independently optional: users can provide either or both.
- Each person has one editable review and rating per movie or show. Separate
  discussion posts can start new conversations about the same title.
- Distinct contributions to a title have their own top-level items and
  replies in the [unified title feed](title-feed.md). A later review does
  not share the earlier recommendation's replies.
- Freeform title comments are independent entries, separate from reviews,
  recommendations, and watch activity. A person can write multiple comments
  about a title without changing any structured entry. New top-level
  comments are created on title pages; replies can be added in every feed
  where the entry is visible. The
  [standalone comment implementation](title-feed.md#standalone-title-comments)
  covers creation under issue #8.
- Authors can [delete standalone comments](title-feed.md#deleting-standalone-comments-preserves-replies--2026-09-07).
  Preserve eligible replies under Comment removed and hide entries with no
  visible replies.
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

The [application stack](application-stack.md) is selected. Features such as
installation or offline support remain open.

### Invite-only launch — 2026-09-04

**Decision:** Make the first release invite-only, starting with the user
and a small group of friends. Each member can invite people they know.
Invitations provide access to join the app; friendships still require the
existing request-and-acceptance process.

**Why:** The user accepted starting with overlapping friend circles to test
the core experience.

### Group-chat invitations — 2026-09-05

**Decision:** Support reusable invitation links so multiple people can join
Screenr through the same link shared in a group chat. A single-use-only
invitation model does not meet this requirement. Joining still follows the
existing sign-in rules and does not automatically create friendships.

**Why:** The user wants to share one invitation in a group chat and have
everyone who follows it be able to use it.

Link usage, revocation, and expiration follow the controls below.

### Invitation controls — 2026-09-05

**Decision:** When creating an invitation link, its creator can set how
many times it may be used, from 1 to 12. The default is 1 use, and 12 is the
application-wide maximum per link. A use means a completed new-account
signup. Clicks, link previews, and existing members signing in do not
consume uses.

The creator can see how many uses each of their links has had and how many
uses remain. For each link, they can also see the display names and
usernames of members who signed up through it, subject to the existing
blocking rules. They can revoke any of their links at any time to prevent
further use. Links expire 30 days after creation, even if uses remain.
Revoked, expired, or exhausted links cannot authorize new signups.

**Why:** The user proposed this model to support group-chat invitations
while giving the creator control over each link's use and visibility into
its remaining capacity.

The user accepted showing who joined so creators can track group
invitations and find those people to send friend requests afterward.

The user specified the default, maximum, and signup-based counting rule.
The reason for choosing the exact values 1 and 12 was not stated.

### Active invitation list — 2026-09-07

**Decision:** Show a shareable link on every active invitation, including
after returning to the invitation page. Remove revoked, expired, and fully
used invitations from this view. Keep their stored signup records.

**Why:** In issue #4, the user requested access to still-active links without
an ever-growing list of old links. Active cards retain signup counts and the
existing visibility rules for members who joined.

The user accepted the 30-day expiration to give group-chat members time to
join while preventing old invitation links from remaining active indefinitely.

### First-time setup — 2026-09-04

**Decision:** After sign-in, require only a display name and username before
entering the app. Adding a profile photo, sending a friend request to the
inviter, and adding a few titles are optional and can be skipped.

**Why:** The user accepted keeping setup short so people can get started
quickly.

### Sign-in methods — 2026-09-05

**Decision:** Support Google sign-in and a one-time code sent to the user's
email address. Both methods follow the existing invite-only access rules.
Users do not create a separate Screenr password.

**Why:** The user accepted using an existing Google account or an email code
so people can choose either route without a separate Screenr password.

Use the [selected authentication library](application-stack.md#authentication-library-decision--2026-09-05)
for this sign-in experience. Use the Resend relay selected below. The dedicated
Google project and callback URLs are recorded in the
[provider configuration](running-screenr.md#provider-configuration).

### One account across sign-in methods — 2026-09-05

**Decision:** Google sign-in and email-code sign-in for the same email
address lead to one Screenr account. Switching methods preserves the
person's friendships, reviews, and history. Verify ownership before linking
the identities, with additional verification when needed; a matching email
address alone is not sufficient proof.

**Why:** The user accepted keeping one social identity and its history
when a person changes sign-in methods.

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

### Watch together — 2026-09-07

The [Watch together decisions](watch-together.md) define the profile entry
point, shared-title inclusion, newest-shared-first order, title-type filter,
and use of existing title pages for choice changes.

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

**Updated — 2026-09-06:** The
[review edit decision](title-feed.md#review-edits-update-and-move-the-existing-item--2026-09-06)
defines how edits update and reorder that review's existing feed item.

### Shared conversation per person and title — 2026-09-04

**Superseded — 2026-09-06:** The
[separate contribution decision](title-feed.md#separate-items-for-later-contributions--2026-09-06)
replaces the rule that all of one person's activity on a title shares one
conversation. See that decision for the reason and tradeoff.

### Standalone movie and show pages — 2026-09-04

**Decision:** Give each movie or show its own standalone page. Show the
title details first. A show's page also includes discussions labelled for
its seasons or episodes. People views and title views use the same content.

**Updated — 2026-09-06:** The [unified title feed](title-feed.md) replaces
the presentation as separate conversations below a title. That document
owns the new layout and top-level item audience rules. A friend's reply
on an otherwise inaccessible item does not grant access to that item.

**Why:** The user wants to browse content through both people and movies or
shows, with all friends' conversations about a title available together.

### Conversation ordering on title pages — 2026-09-04

**Updated — 2026-09-06:** The
[title-feed ordering decision](title-feed.md#order-items-by-recent-visible-activity--2026-09-06)
carries forward ordering by recent visible activity for individual
top-level items. It owns the current rule and its tradeoff.

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

**Clarified — 2026-09-07:** A feed item, such as a recommendation, has direct
comments. Each direct comment can have a group of nested replies beneath it.
Use indentation and a graphical connection to show that the nested replies
address that comment. The maximum depth is one additional level beneath a
direct comment. This refines the unified feed's previous flat presentation
of all replies beneath the feed item.

**Why:** The user wants to distinguish a reply to the recommendation itself
from a reply to an individual comment in its discussion. The additional
indentation makes the relationship visible.

[Issue #32](https://github.com/jubishop/screenr/issues/32) tracks this nested
layout, composer placement, unavailable-parent handling, and the
[updated feed preview](title-feed.md#preview-three-replies-and-expand-inline--2026-09-06).

### Reply composer placement — 2026-09-07

**Decision:** Selecting Reply on a comment opens the nested reply composer
directly beneath that comment. Label it Replying to @name and provide a
Cancel action. Keep a separate general reply composer at the bottom of the
discussion for direct comments on the feed item itself.

**Why:** The user accepted this placement so that people can see where
their reply will go while writing it.

### Nested replies beneath a blocked author — 2026-09-07

**Decision:** When blocking hides a direct comment's author, retain nested
replies that the reader can otherwise access beneath a Comment unavailable
placeholder. Do not show the blocked author's name or comment text. Apply
the existing access rules to each remaining reply and its addressed-person
label. The placeholder preserves grouping; it does not grant access to a
hidden parent comment or to the feed item itself.

**Why:** The user accepted preserving the readable parts of the conversation
and their grouping. Hiding the entire nested group would also hide replies
from people the reader can still see.

### Incoming replies in an open conversation — 2026-09-05

**Decision:** When other people add comments or replies to an open
conversation, show a "New replies" button. Load them when the reader selects
it, preserving their reading position. A person's own reply appears
immediately after successful posting.

Existing access, blocking, and spoiler rules still apply. Enforcing access
changes must not depend on the reader selecting "New replies". The update
transport and timing remain implementation choices.

**Why:** The user accepted this behavior to keep the conversation from
shifting while someone reads or composes a reply.

**Updated — 2026-09-06:** The
[title-feed update rule](title-feed.md#load-incoming-activity-without-moving-the-reader--2026-09-06)
extends this behavior to incoming activity and item reordering in the
unified title feed.

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

**Update — 2026-09-07:** [Issue #36](https://github.com/jubishop/screenr/issues/36)
adds access to any user's accepted friends from their profile to help with
friend discovery. Friend lists require sign-in and link to each person's
profile. Pending requests stay private. Blocking hides the blocked profile
and filters blocked people from other profiles' lists in either direction.
The list and its count include only people visible to the viewer.

### Profile visibility before friendship — 2026-09-04

**Decision:** Require sign-in before showing a profile, including through
shared profile links. Signed-in users who are not accepted friends see
the person's display name, username, photo, and friend-request button,
subject to the existing blocking rules. The 2026-09-07 friend-discovery
update above adds accepted friend lists to this profile information.

Watch activity, ratings, reviews, and recommendations are visible to their
owner and the owner's current accepted friends. Viewing a profile or having
a pending friend request does not grant access to that content.

**Why:** The user accepted a minimal profile for finding friends while
keeping viewing activity and opinions within accepted friendships.

### Friends feed — 2026-09-04

**Decision:** Automatically include watch-status changes and ratings in the
friends feed, alongside reviews, recommendations, and discussion posts.
Apply the existing content audience and blocking rules.

**Updated — 2026-09-06:** The [shared feed decisions](title-feed.md) define
interactive entries, recent-visible-activity ordering, and inline replies
across the friends, title, and profile feeds. Recommend and Want to watch
have separate entries and reply groups, replacing aggregation of all of a
person's title activity. This does not change the earlier grouping rule
for other future features: changes saved together by one person for a
title form one update, such as finishing and rating a movie together.
Implementing those features is outside issue #5.

**Why:** The user initially accepted automatic activity updates. The newer
decisions make each contribution independently discussable in every feed.

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

### First-release success and measurement — 2026-09-05

**Decision:** Judge the first release by whether the initial group keeps
returning, chooses things to watch through friends' recommendations, and
keeps conversations going. Determine relative success by looking directly
at usage telemetry. Do not assess this through user surveys.

**Why:** The user agreed with these success criteria but finds surveys
annoying and prefers observing usage directly. This replaces the proposed
plan to ask the group about its experience after a few weeks.

Event definitions, recommendation attribution, and reporting tools remain
open. Measurement must distinguish observed app actions from
inferences about recommendation influence or viewing outside the app.

### Initial usage measures — 2026-09-05

**Decision:** Start with three usage measures:

- Members who return each week.
- Titles saved from friends' recommendations and subsequently marked
  Watching, Caught up, or Finished.
- Conversations involving at least two people, including repeat
  participation.

**Why:** The user accepted these measures for the agreed success criteria
of repeat use, choosing titles through friends, and sustained conversation.

### Movie and TV catalog source — 2026-09-05

**Decision:** Use The Movie Database (TMDB) for the movie and TV catalog,
including title search, details, images, and season or episode metadata.

**Why:** The user accepted one service covering the movie and TV entities
Screenr needs. See TMDB's [search and details guide](https://developer.themoviedb.org/docs/search-and-query-for-details)
and [supported detail entities](https://developer.themoviedb.org/docs/append-to-response).

**Service conditions:** TMDB's developer API is free for non-commercial use
with attribution. Commercial use requires a commercial license. TMDB defines
a commercial project by whether its primary purpose is to create revenue
for its owner. Its attribution rules require an approved logo and notice in
an About or Credits section. See the [TMDB FAQ](https://developer.themoviedb.org/docs/faq),
checked on 2026-09-05.

### At-home title availability — 2026-09-07

The [title availability decisions](title-availability.md) define the
accepted US scope, TMDB data source, cache behavior, and title-page display
for [issue #7](https://github.com/jubishop/screenr/issues/7).

### Non-commercial scope — 2026-09-05

**Decision:** Treat Screenr as a non-commercial experiment for now, focused
on usefulness to the user's circle, with no ads or paid features. Plan to
use TMDB's developer API for this scope and meet its attribution requirements.
Revisit the TMDB license if the project's purpose changes to generating
revenue.

**Why:** The user accepted establishing whether people keep using Screenr
before choosing a business model.

### Hetzner and self-hosted services — 2026-09-05

**Decision:** Use a Hetzner VPS and operate Screenr's core application,
database, authentication, background work, and usage telemetry ourselves.
Build the required application functionality using suitable software
components rather than making managed application, database, or
authentication services the default.

**Why:** The user prefers to provide the software ourselves and use Hetzner
for the underlying VPS. This replaces the proposed managed-services approach.

The existing TMDB catalog and Google sign-in choices remain in place.
The [application stack](application-stack.md) and
[initial single-server layout](application-stack.md#initial-hosting-layout--2026-09-05)
are selected. Initially use the existing shared VPS; deployment setup and
backup details remain implementation choices. The outbound email delivery
boundary is defined below.

### External email relay — 2026-09-05

**Decision:** Use an external email relay for outbound delivery while
self-hosting Screenr's core services. Screenr owns the login-code and
notification logic, including when to send email and what it contains.
Use Resend under the relay-provider decision below.

**Why:** The user accepted using a relay to handle email delivery without
operating our own mail server. This is an explicit exception to the
self-hosting preference, alongside the existing catalog and Google sign-in
integrations.

### Email relay provider — 2026-09-05

**Decision:** Reuse the existing Resend account on its free plan for
Screenr's login codes and, when implemented, enabled email alerts.

**Why:** The user accepted reusing the existing service while avoiding new
costs. If its limits become a problem, decide how to proceed at that time.

Configure a verified sender domain for Screenr. Keep sending credentials
private and use only the permissions required to send email. The application
must handle delivery errors and provider limits without silently upgrading
the account or losing queued messages.

### First development milestone — 2026-09-05

**Decision:** Build the first working milestone around this complete
experience: two invited people sign in and become accepted friends; one
finds and recommends a movie or show; the other sees it in the friends feed
and on the standalone title page, saves it to Want to watch, and replies in
the shared conversation. Unfriending and blocking enforce the previously
agreed access rules.

**Why:** The user accepted this milestone so Screenr's core experience can
be tried early. The remaining agreed features follow in later development
milestones before the first release; this does not reduce the release scope.

[GitHub issue #1](https://github.com/jubishop/screenr/issues/1) owns the
implementation work and acceptance criteria.

### First milestone includes live deployment — 2026-09-05

**Decision:** Include a live Hetzner deployment in the first development
milestone, alongside the repeatable local setup and automated checks.

**Why:** The user confirmed that issue #1 should include live deployment.
No further reason was stated.

Use the existing shared VPS under the revised
[hosting decision](application-stack.md#initial-hosting-layout--2026-09-05),
which also records the user's preference to avoid new costs until measured
limits require a decision. The public hostname is selected below; use the
Resend relay selected above.

The [release workflow](development-workflow.md#review-merge-and-deploy)
records the initial bootstrap exception and the normal requirement to review
and merge changes before production deployment.

### Public hostname — 2026-09-06

**Decision:** Move the live application to `screenr.club`.

**Why:** In [issue #9](https://github.com/jubishop/screenr/issues/9), the user
requested the move and confirmed that they had registered the domain with
Cloudflare. This supersedes the 2026-09-05 choice of `screenr.jubishop.com`.

The [domain cutover procedure](deployment.md#domain-cutover) keeps the existing
VPS and preserves old shared links through redirects. The decision does not
mean that DNS, provider settings, or production have already changed.

## Open decisions

- Deployment configuration; routine backup settings can be chosen during
  implementation under the [initial backup scope](application-stack.md#initial-backup-scope--2026-09-05).
- Telemetry event definitions, attribution, and implementation.
- The detailed first-release delivery scope.
