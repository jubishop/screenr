---
status: current
---

# Interface design

Layout and presentation decisions for Screenr's member pages. They came
from a 2026-10-12 design review of the phone (390px) and desktop (1366px)
layouts with seeded local data. Behavior rules for feeds stay in the
[unified title feed](title-feed.md) decisions. The review's Watch together
change is recorded with the other
[Watch together decisions](watch-together.md#prompt-to-save-streaming-services--2026-10-12).

## Accepted decisions

### Full-width feed entry actions — 2026-10-12

**Decision:** Keep the poster beside the author line, title, and metadata at
the top of each feed entry. Place the entry actions beneath that block across
the full card width. On desktop they form one row. On phone they form at most
two rows: the title actions first, then reaction counts and React. Each
comment shows Reply, React, and its reaction counts on one line.

Align React with the other text actions, and remove the empty space that the
copy-status message reserves beneath each entry when it has no message.

**Why:** The user accepted this after the design review found that six feed
entries filled seven phone screens. On phone, each action stacked on its own
row in the narrow column beside the poster, and React sat on a separate,
indented row in every entry and comment.

**Rejected alternatives:** A wrapping row beside the poster saves less height
because that column is about 250px wide on phone. Fixing only the alignment
and spacing would keep the vertical stack.

### Copy link as an icon button — 2026-10-12

**Decision:** Show **Copy link to discussion** as a link icon button at the
end of the title-actions row. Keep "Copy link to discussion" as its
accessible name and hover tooltip. Keep the behavior from
[issue #19](https://github.com/jubishop/screenr/issues/19): copy the full
item URL, stay on the current page, and show "Link copied." beside the
button, or the existing error message when copying fails.

**Why:** The user accepted the icon so phone entries keep at most two action
rows. The full text label would wrap onto a third row at 390px.

**Rejected alternatives:** A shorter "Copy link" text label may still wrap on
narrower phones. The full label needs its own row on phone.

### Reply count instead of a Conversation heading — 2026-10-12

**Decision:** Remove the visible "Conversation" heading above an entry's
comments. Keep the reply count as small muted text above the comments, using
"1 reply" for a single reply. Keep "Conversation" as the accessible name of
the comment section. Entries without comments continue to show neither the
count nor a heading, as decided in
[issue #42](https://github.com/jubishop/screenr/issues/42).

**Why:** The user accepted removing a heading that repeated on every entry
with comments. The comments' left rule already marks where the discussion
starts, and removing the heading saves about 50px per entry.

### Remove decorative page chrome — 2026-10-12

**Decision:** Remove the top bar that shows "YOUR PEOPLE. YOUR PICKS." and
"A private circle" on every member page. Remove the "Good company. Great
things to watch." slogan from the desktop sidebar. Keep the screenr logo and
the login page branding.

**Why:** The user accepted removing repeated branding that pushed content
down. On phone, the top bar added about 70px to every page before its
content.

### Four-item navigation with a phone bottom bar — 2026-10-12

**Decision:** Reduce the main navigation to four items: Your circle, Find a
title, Friends, and Account. Move Invite friends to a prominent button at the
top of the Friends page that opens the existing invitations page. Mark
Friends as the current section on the invitations page. The desktop sidebar
uses the same four items.

On phone, show the navigation as a bar fixed to the bottom of the screen,
clear of the device's bottom safe area. Keep a slim sticky top header, about
56px tall, with the logo and notification bell.

**Why:** The user accepted moving navigation within thumb reach and freeing
the top of the screen. The current sticky phone header with five tabs is
about 136px tall, and the "Invite friends" label wraps onto two lines.

**Rejected alternatives:** Four top tabs would still use about 110px at the
top of the screen. A five-tab bottom bar would keep Invite friends as a
primary destination.

### Plain page titles — 2026-10-12

**Decision:** Title each member page with its name in a smaller heading.
Remove the small uppercase label above each heading. Keep a subtitle only
where it explains how the page works.

| Page | Heading | Subtitle |
| --- | --- | --- |
| Friends feed | Your circle | None |
| Find a title | Find a title | None |
| Friends | Friends | None |
| Invitations | Invite friends | Keep the explanation of the 30-day link and automatic friendship. |
| Account | Account | None. Move "Keep the same profile and friendships when you change sign-in methods." into the Sign-in methods section. |
| Watch together | Watch together | Keep the participants and the explanation of the result order. |

Title and profile pages keep the title or person's name as the heading.

**Why:** The user accepted plain titles after the review found that the
friends feed heading, its label, and its subtitle used about 330px of a
phone screen before the first entry. Slogans such as "One you. One circle."
on Account and "What's on your mind?" on Find a title did not name the page.

**Rejected alternative:** Compacting only the friends feed would keep the
slogans on the other pages.

### Relative activity times and release years — 2026-10-12

**Decision:** Show a feed entry's activity time on its author line, for
example "Maya Chen recommends · 2h". Show the release year on the metadata
line, for example "TV show · 2022", and only the kind when the year is
unknown.

Feed entries, comments, and notifications use one time format: "now" under
a minute, then minutes, hours, or days ("5m", "2h", "3d") under a week, then
the month and day ("Oct 12"), with the year when it is not the current year.
Each time shows the full date and time on hover. Invitation expiry and
availability check times keep their current formats.

**Why:** The user accepted this after the review found that the activity date
sat where the title page shows the release year, so "TV show · 10/12/2026"
read like a release date. Activity times also used three formats:
"10/12/2026", "Oct 12", and "Oct 12, 8:29 AM".

**Rejected alternative:** Absolute dates in one format would fix the
placement and consistency but make recent activity less obvious.

### Compact entries on title pages — 2026-10-12

**Decision:** On a movie or TV title page, show feed entries without the
poster, title name, metadata line, or Want to watch and Recommend buttons;
the page header already provides them. Each compact entry keeps its author
line with the activity time, its body or spoiler control, reactions, and
comments. Place the copy link icon at the end of the author line. Drop "on"
from "commented on" when the title name is absent.

Friends and profile feeds keep full entries.

**Why:** The user accepted removing content that repeated the page header in
every entry on the title page.

**Rejected alternatives:** Removing only the poster would still repeat the
title name and actions. Keeping full entries repeats the header in each one.

### Friend activity in the title header — 2026-10-12

**Decision:** Below the title page's Recommend and Want to watch buttons,
summarize which friends currently recommend or want to watch the title, for
example "Recommended by Maya Chen and Sam Okafor · Theo Park wants to watch".
List recommenders first. Show up to three names in each group, followed by
"and N more" when there are others. Each name scrolls to that person's entry
in the title feed. Hide the line when no friend has either action.

Include only current accepted friends, subject to the title feed's access
and blocking rules. The header buttons already show the viewer's own choice.

**Why:** The user accepted surfacing friends' signals at the top of the page.
Today they appear only in the feed, below the availability and trailer
sections.

### Trailer collapsed until played — 2026-10-12

**Decision:** When a title has a supported trailer, show a one-line
"Play trailer" button with the existing Watch on YouTube link in place of the
open player. Activating the button expands the responsive 16:9 player inline
and starts playback where the browser allows it. Do not load the YouTube
player until the viewer activates the button. Keep the existing referrer
policy, the direct YouTube link, and the fallback text once the player is
open. The player stays open through page refreshes.

**Why:** The user accepted collapsing the trailer because on desktop the
open player filled a full screen above friends' discussion. Not loading the
player also avoids contacting YouTube for viewers who never play it.

**Rejected alternatives:** Moving the open player below the feed would keep
its height on every visit. Keeping it in place leaves the discussion below
the fold.

### Start a conversation from the section heading — 2026-10-12

**Decision:** Remove the card that holds only the Start a conversation
button on title pages. Place a compact Start a conversation button on the
"Around this title" heading row, in place of the "Your circle's
conversations" note. Activating it opens the existing composer card beneath
the heading. The text field stays hidden until the reader chooses the
button, as decided in [issue #56](https://github.com/jubishop/screenr/issues/56).

**Why:** The user accepted removing a full-width card that looked empty
because it contained only one small text button.

**Rejected alternative:** A button styled like an empty text field would
keep the card's height.

### Avatars wherever a person appears — 2026-10-12

**Decision:** Use one avatar component wherever a member appears: feed entry
author lines, comments and replies, Friends and People suggestion rows, Watch
together participants, the profile header, notifications, and the sidebar.
Until profile photos exist, show the first letter of the display name on a
muted background color. Choose the color from a small fixed palette using the
member's stable user ID, so it stays the same after a username change. The
letter must meet the existing text contrast requirements. Avatars beside a
visible name are decorative for assistive technology. Comments without an
available author use a neutral placeholder.

The profile header shows the avatar beside the display name, with the
@username in normal text below the name. This replaces the spaced uppercase
label above the name.

A future profile photo replaces the initial in the same component.

**Why:** The user accepted avatars across the app because people are the
main cue for scanning a social feed, and initials currently appear only in
the sidebar and notifications. The spaced label made usernames read as
"@a l e x".

**Rejected alternatives:** Limiting avatars to people lists and profiles
would leave feeds and comments without them. Waiting for photos leaves the
current gap until a separate feature ships.

### Sectioned Friends page — 2026-10-12

**Decision:** Order the Friends page sections as follows, omitting any empty
relationship section:

1. Requests: incoming friend requests with Accept and Decline.
2. Friends: accepted friends. Each row shows the avatar, display name, and
   @username, and the whole row opens the person's profile. Rows have no
   Friends badge or Unfriend button.
3. Sent requests: outgoing requests with "Request sent" and Cancel.
4. People you may know.
5. Blocked people.

Unfriending moves to the person's profile. On phone, each row keeps its
actions on the same line as the person; the @username may wrap beneath the
display name. Keep the Find person button on one line at every width.

**Why:** The user accepted separating relationship states after the review
found an incoming request sorted alphabetically among existing friends. Every
friend row also exposed Unfriend, which takes effect on a single tap.

**Rejected alternatives:** Keeping Unfriend on friend rows would leave a
one-tap removal beside every friend. Keeping one list would only fix the
layout problems.

### Profile actions menu with confirmation — 2026-10-12

**Decision:** On another member's profile, move Unfriend (for accepted
friends) and Block into a "More actions" menu shown as "…" after the main
actions. Watch together and the friend-request actions (send, cancel, or
accept) stay visible. The menu button names the person for assistive
technology, reports whether it is expanded, and closes on Escape or when the
reader moves focus or clicks outside it.

Choosing Unfriend or Block shows an in-page confirmation that states the
effect under the existing [unfriending](product-brief.md#access-after-unfriending--2026-09-04)
and [blocking](product-brief.md#blocking--2026-09-04) rules. It offers the
action and Cancel. For example: "Unfriend Maya Chen? You'll both lose access
to each other's posts and discussions." Do not use a browser dialog. Unblock
remains available from Blocked people on the Friends page.

**Why:** The user accepted guarding both actions because each takes effect on
a single tap today. Unfriending removes access to each other's content and
hides comments, and blocking also prevents new friend requests.

**Rejected alternatives:** A menu without confirmation would still act on a
single choice. Visible buttons with confirmation would keep destructive
actions beside Watch together.

### Interface polish — 2026-10-12

**Decision:** Include these smaller changes:

- **Descriptions:** On Find a title search results and Watch together, show
  the full title description clamped to two lines with an ellipsis instead
  of cutting it at 150 characters, which can end mid-word.
- **Row indicators:** End search and Watch together rows with a chevron
  instead of the upper-right arrow. The rows open pages inside Screenr, and
  the arrow suggests an external link.
- **Icons:** Replace the text-symbol navigation icons with one small set of
  inline SVG icons owned by Screenr, without a new dependency. Use the same
  set for the copy link, more actions, play, and chevron icons.
- **Friend requests in notifications:** While a friend request is still
  pending, show Accept and Decline on its notification. Either action marks
  that notification read and replaces the buttons with the result. Selecting
  the rest of the notification keeps its current behavior.

**Why:** The user selected all four items from the design review. The
navigation symbols rendered at mismatched sizes, and accepting a request
otherwise required leaving the panel for the Friends page.

### Dark theme follows the system setting — 2026-10-12

**Decision:** Add a dark color theme that follows the device's light or dark
appearance setting, with no in-app control. Cover every member page, the
login and setup pages, and the credits page. Define all interface colors as
shared theme values so both themes use the same names, and declare the
supported color schemes so form controls and scrollbars match. Posters,
streaming service logos, and the trailer player keep their own colors. Text
in both themes meets the existing contrast requirements, and the contrast
tests check both themes.

**Why:** The user chose to include a dark theme after the review noted that
Screenr has none, while people often browse TV and movies in a dark room.

**Rejected alternatives:** A Light, Dark, and System control in Account adds
a setting to store and apply before the first paint. Deferring the theme to a
separate issue was also offered.
