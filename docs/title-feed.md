---
status: current
---

# Unified title feed

This document owns the confirmed product decisions for the unified movie
and TV title feed and its shared entries in the friends and profile feeds.
[Issue #5](https://github.com/jubishop/screenr/issues/5) tracks implementation
and acceptance criteria. Unanswered choices are listed separately below;
the implementation details below describe the current storage and interface.

## Accepted decisions

### One feed beneath each title — 2026-09-06

**Decision:** Show one feed beneath the title details. Mix discussion
comments with inline reviews, recommendations, and other agreed activity
items that people can reply to. Show replies beneath their top-level item,
with one level of nesting. Replies to replies remain at that same level,
with the addressed person shown.

Show the viewer's own top-level items and those of their current accepted
friends, subject to blocking. People who are not the viewer's friends can
appear as replies under an eligible item, not as top-level items.

**Why:** The user wants to read the conversation about a title at a glance
instead of opening separate conversations around each person's activity.
This replaces the separate-conversation presentation in the product brief.
The decisions below define the existing action types and update behavior;
future entry types remain separate work.

### The top-level author determines the audience — 2026-09-06

**Decision:** Each top-level item and its replies are accessible only to
that item's author and the author's current accepted friends, subject to
blocking. Only those people can reply. Each participant can see replies
from the author and the author's current friends, even if those people
are not the participant's own friends. Apply the existing unfriending,
friendship restoration, and blocking rules to that group.

A reply does not grant the reply author's other friends access to the
top-level item. Do not promote a reply into a top-level item or show it
outside its eligible parent merely because its author is the viewer's friend.

For example, Alice is the viewer's friend. Ben is Alice's friend but not
the viewer's friend. The viewer sees Alice's review and Ben's replies to
it, and can reply there. The viewer does not see Ben's own reviews or
top-level comments. The viewer's reply does not expose Alice's review to
the viewer's other friends.

**Why:** The user accepted this boundary to match the friends-only
top-level feed and preserve the existing content privacy rules. The
tradeoff is that each person sees a different selection of the title's
conversation.

### Separate items for later contributions — 2026-09-06

**Decision:** A later, distinct contribution creates its own top-level
item with its own replies. For example, Alice's Monday recommendation and
Friday review appear as two items in the same title feed. Replies stay
attached to the item they address. Ordinary discussion comments are also
independent top-level items unless explicitly written as replies.

This replaces the shared conversation for all of one person's activity
on a title. The later decisions below define review edits and the
separate Recommend and Want to watch items. Combinations involving future
activity types remain deferred.

**Why:** The user accepted keeping the context of each discussion clear.
The tradeoff is that one person can have several items in a title's feed.

### Freeform comments are independent entries — 2026-09-06

**Decision:** A person can write a freeform top-level comment about a
movie or show. Each comment is its own feed entry, separate from
structured entries such as reviews, recommendations, Want to watch, or
Watched activity. Writing a freeform comment does not require creating
or changing any structured entry. A person can contribute multiple
independent comments about the same title.

These comments appear in the same unified feed and follow its top-level
author audience and one-level reply rules. They are distinct from replies
written beneath another entry.

**Why:** The user explicitly wants someone to be able to post a thought
about a show independently of their structured activity. The user noted
that this capability is not implemented yet. It is deferred from issue #5
under the delivery-scope decision below.

### Review edits update and move the existing item — 2026-09-06

**Decision:** Editing a review updates its existing feed item in place
and preserves its replies. Show an Edited label. Use the review's most
recent edit date to move that item up in the chronological feed. Do not
create a separate feed item for the edit.

**Why:** The user accepted updating the original item and explicitly
requires its newer edit date to move it up in the feed. This replaces
the proposed ordering by original posting date for edited reviews.
Existing replies may refer to an earlier version of the review.

### Order items by recent visible activity — 2026-09-06

**Decision:** Order top-level title-feed items by their most recent
activity visible to the reader, newest first. A new visible reply moves
its top-level item up in the feed. Review edits also move the existing
item up, as specified above. Activity hidden by access or blocking rules
does not affect that reader's ordering.

**Why:** The user accepted this behavior to keep active discussions easy
to find. It carries forward the earlier title-page ordering rule, applied
to the unified feed's top-level items. An older item with a new reply can
appear above a newly posted item.

### Preview three replies and expand inline — 2026-09-06

**Decision:** Initially show the latest three replies that the reader is
allowed to see beneath each top-level item. If there are fewer, show all
of them. Display the visible replies oldest to newest. Provide Show
earlier replies to expand the remaining eligible replies inline on the
same title page, with the expanded replies also ordered oldest to newest.
Access and blocking rules apply before selecting the three-reply preview.
Spoiler rules still apply to the displayed replies.

**Why:** The user accepted keeping the phone feed easy to scan while
allowing the full discussion to be read without leaving the title page.
The tradeoff is an extra tap to see earlier context.

### Open title-related links in the unified feed — 2026-09-06

**Decision:** Permalinks to title-related content from the friends feed,
profiles, and notifications open the corresponding item inside that
title's unified feed. Scroll to the target item and expand the target
reply when necessary, including when it is outside the initial preview.
Opening a link does not reveal spoiler text; the reader must still
choose to reveal it. Access and blocking rules apply to the destination.

**Why:** The user accepted making the title page the common place to
read and join a title's discussion. This replaces opening a separate
conversation page as the normal destination for title-related content.

**Clarified — 2026-09-06:** This link behavior does not make the title
page the only place to read or reply. The shared interactive-feed decision
below requires reading and replying directly from friends and profile
feeds as well. A title-related permalink can still open its target on
the title page.

**Updated — 2026-09-07:** Feed entries show **Copy link to discussion**.
Activating this control copies the full item URL to the clipboard and keeps
the current page open. Opening the copied URL still follows the permalink
rules above. In [issue #19](https://github.com/jubishop/screenr/issues/19),
the user requested this change because the discussion is already available
inline and the link is useful for sharing it with other people.

### Withdrawing a recommendation preserves its discussion — 2026-09-06

**Decision:** If a person removes a recommendation that already has
replies, keep its feed item and discussion visible to the eligible
audience. Clearly label it as removed, for example, Alice removed her
recommendation. It no longer counts as an active recommendation, including
in Friends recommend. The existing audience, blocking, and spoiler rules
still apply to the retained item and replies.

**Why:** The user accepted preserving the conversation without suggesting
that the author still recommends the title. The removal visibility and
ordering decision below applies to the retained item.

### Recommending again reuses the same item — 2026-09-06

**Decision:** If a person recommends a title again after withdrawing the
recommendation, reactivate the same recommendation item. Preserve its
replies and move it up using the new recommendation date. Keep one
recommendation item per person per title. Repeated toggles do not create
duplicate recommendation discussions.

**Why:** The user accepted keeping the discussion together when a
recommendation is restored while making the renewed recommendation visible
as recent activity.

### Want to watch uses the same item lifecycle — 2026-09-06

**Decision:** Recommend and Want to watch each have their own item per
person per title. Removing either action preserves any discussion and
marks the action as removed. Adding the action again reuses its existing
item, keeps the replies, and moves the item up using the new activation
date. Recommend and Want to watch do not share a reply group.

**Why:** The user accepted applying the same behavior to both actions.
This keeps each action's discussion together while keeping distinct
structured actions separate.

### Removing an action does not move it up — 2026-09-06

**Decision:** When Recommend or Want to watch is removed, hide its item
from a reader who has no visible replies beneath it. If replies remain
visible to that reader, retain the item and mark the action as removed.
The removal itself does not move the item up in the feed. A later visible
reply or reactivation still moves it up under the existing ordering rules.
Hiding an item is not deletion; reactivation reuses it and its replies.

**Why:** The user accepted removing empty activity from the feed while
preserving discussions. Visibility is evaluated for each reader so hidden
replies do not cause otherwise empty removed items to appear.

### Preserve existing discussions during migration — 2026-09-06

**Decision:** Keep each existing conversation's replies together under
an Earlier discussion item in the unified feed. Preserve its original
owner and audience. New activity uses the separate structured items
defined above. Do not guess whether an old reply belongs to Recommend or
Want to watch, duplicate it across those items, or promote it to an
independent comment owned by its reply author.

**Why:** The current data attaches replies to a shared person-and-title
conversation, without identifying the structured action they concern.
The user accepted preserving those discussions intact instead of
guessing how to redistribute their replies.

### Load incoming activity without moving the reader — 2026-09-06

**Decision:** While someone reads the title feed, hold other people's
incoming activity behind a New activity button before inserting items or
reordering them. Selecting the button updates the feed while preserving
the reading position and any reply draft. The reader's own actions and
replies appear immediately after successful saving.

Access changes and action-removed labels apply immediately. Waiting to
load new activity must not preserve revoked access or show a withdrawn
recommendation as active. Spoiler restrictions also continue to apply.

**Why:** The user accepted extending the existing manual new-reply
loading behavior to the unified feed, so incoming activity does not
disrupt reading or composition.

### Standalone comment creation is a follow-up — 2026-09-06

**Decision:** Keep creation of freeform top-level title comments out of
the change for issue #5. Track that capability in a separate follow-up
issue, [#8](https://github.com/jubishop/screenr/issues/8). The unified feed
must accommodate those future independent entries, but the current change
does not add their composer or creation behavior. Reviews, ratings, and
additional watch statuses are also later feature work; this issue defines
their agreed feed behavior without requiring their implementation.

**Why:** The user wants to keep the current pull request's scope small
and explicitly requested a follow-up issue for standalone comments.

### Read and reply in friends and profile feeds too — 2026-09-06

**Decision:** The friends feed and profile pages also show interactive
feed entries. People can view discussions and reply directly there, as
well as on title pages. These views use the same underlying entries and
reply groups; replies and changes are not separate copies for each view.

This is in scope for issue #5. It replaces the proposed restriction to
summary cards that require opening a title page to read and reply.
Standalone freeform comment creation remains deferred to #8.

**Why:** The user explicitly wants the stories in friends and profile
feeds to be viewable and commentable there, rather than having to leave
those feeds for the discussion.

### Feed filters and consistent interaction — 2026-09-06

**Decision:** Use the same entries and reply groups with these filters:

| View | Top-level entries |
| --- | --- |
| Friends feed | The viewer's own entries and current friends' entries across titles. |
| Title page | The viewer's own entries and current friends' entries for that title. |
| Profile page | Entries authored by the profile owner, subject to the viewer's access. |

Replies by the profile owner on other people's entries stay attached to
those original entries; they are not promoted into top-level profile
entries. The same activity ordering, three-reply preview, inline
expansion, and New activity behavior apply in all three views. Reading,
replying, and viewing updates operate on the same stored discussion.

**Why:** The user confirmed profiles should show their owner's entries
and wants the same interactive discussions available wherever they appear.

### Create top-level comments on titles; reply in every feed — 2026-09-06

**Decision:** In follow-up #8, new standalone top-level comments are
created on the relevant title page. These comments appear under the feed
filters above. People can add replies wherever an eligible entry is
visible, including the friends feed and profile pages. Those pages do not
get a standalone top-level comment composer as part of #8.

**Why:** The user explicitly requested replies in every feed and said
new top-level title comments make sense on the title page. Posting directly
to a friend's profile was mentioned only as a possible later feature.

## Existing rules that continue to apply

These rules come from the [product brief](product-brief.md). The feed
change does not grant a larger audience or introduce new moderation
powers:

- Enforce current friendship and blocking rules on server reads and writes,
  including direct links, reply targets, previews, and counts. Recheck access
  on an open page without waiting for the reader to load new activity.
- Apply the [spoiler rules](product-brief.md#spoiler-flags--2026-09-04)
  to each item and its reply group. Opening or expanding a discussion does
  not bypass a required spoiler reveal. Spoiler text stays out of previews.
- The top-level owner can remove replies in that discussion under the
  existing [author removal rule](product-brief.md#comment-removal-by-the-conversations-author--2026-09-04).
  Preserve replies to a removed comment and its placeholder. Access loss
  to a top-level item hides its whole group; it does not expose orphaned
  replies elsewhere in the feed.
- Notifications retain their existing triggers and access restrictions.
  Where a notification already exists, its title-related target opens in
  the unified feed as specified above. This change does not require adding
  an unimplemented notification feature.

## Implementation boundaries

The product choices for #5 are resolved. Issue #5 owns its implementation
criteria. Routine implementation choices do not require another product
interview if they preserve these decisions:

- Preserve existing conversation links by resolving them to their migrated
  discussion on the title page when one exists. Where a conversation has
  no old discussion, resolve to its corresponding eligible action item or
  title feed. An unavailable target must not expose inaccessible content.
- Preserve old comment identities, authors, timestamps, spoiler and removal
  state, and addressed-person context. Render old comments and their replies
  at one level beneath the Earlier discussion item. Do not invent action
  history or create empty Earlier discussion items without old comments.
- Pagination, page sizes, stable ordering tie-breakers, and the update
  transport are implementation choices. Loading older items or expanding
  replies must preserve access filtering, the reading position, and drafts.
- Keep this change limited to existing Recommend and Want to watch actions,
  existing discussions, and the three interactive feed surfaces. New feature
  types remain separate work as noted above.

## Shared feed implementation

`src/server/social.ts` reads each eligible `feed_item` and its replies in one
PostgreSQL snapshot. The friends, title, and profile screens use this same
read path. Items sort by the latest eligible activity at millisecond precision,
then by item UUID for a stable tie. Removed comments remain placeholders but
do not add activity or count as live replies. A withdrawn action with only
removed or inaccessible replies is hidden; its stored item remains reusable.

`src/components/feed.tsx` supplies the shared interface. It initially renders
the latest three eligible replies, in timestamp and comment-ID order. Earlier
replies expand inline. Loading incoming replies retains the displayed preview
so the reply being read stays in place; a fresh page starts with three again.
All eligible items and replies are currently read in
one request; there is no loaded-page boundary that can omit a link target.
This retains the application's small-circle, unpaginated read model.

Open feeds use the existing three-second poll, focus refresh, and ten-second
refresh deadline. A failed refresh hides server content. Local drafts remain
in memory. Accepted item dates and reply IDs hold incoming activity until the
reader selects **New activity**. Current access, removal state, and spoiler
flags always come from the latest authorized snapshot. Own actions and replies
appear after saving. Updating the feed or expanding replies preserves the
visible reading anchor and the draft.

Item links use `/titles/<kind>/<tmdb-id>?item=<item-id>`. A targeted reply adds
`&reply=<comment-id>`. The server checks the title, item, and reply together;
the browser expands and scrolls to an eligible target without revealing its
spoilers. Old `/conversations/<id>` links redirect to the preserved discussion,
an eligible action, or the title feed. Inaccessible targets reveal no private
content. Existing notification features are unchanged; these same title links
are available to future notification work.

### Migration and rollback compatibility

Migration `004-feed-items.sql` adds `feed_item` and `comment.feed_item_id`.
Existing comments remain on an **Earlier discussion** item with the original
conversation ID. The migration preserves every existing comment field and
creates no empty earlier discussion. Active Recommend and Want to watch flags
create separate items with the old shared activity date. That date is the only
available historical timestamp; the migration does not infer separate past
action dates.

The original `conversation` rows remain as the title-state and old-link record.
New action writes update them in the same transaction. Database triggers also
synchronize action changes made by the previous app version. Old-version
comments, which have no action identity, attach to an earlier discussion;
new-version comments supply their item ID. A composite foreign key prevents a
reply from crossing between person/title conversations. This additive design
keeps the preceding release usable during activation or rollback, as required
by the [deployment procedure](deployment.md#build-and-activate-a-release).

## Decisions deferred to future features

- How edits to future freeform comments affect existing items. Standalone
  comment creation is tracked in #8; comment editing is not required there.
- Implementation of future watch statuses and combinations of review,
  rating, or watch changes saved together. The existing
  [grouped-update rule](product-brief.md#friends-feed--2026-09-04) for those
  other future features is unchanged. Recommend and Want to watch each
  have their own item and reply group.
- Posting directly to a friend's profile, like a profile wall, is a future
  idea. It is not an accepted feature requirement or part of #5 or #8.
