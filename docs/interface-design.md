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
[Issue #165](https://github.com/jubishop/screenr/issues/165) and its
sub-issues track implementation. The trailer is tracked in
[#112](https://github.com/jubishop/screenr/issues/112), the other destructive
actions in [#132](https://github.com/jubishop/screenr/issues/132), and the
Friends recommend tab in [#102](https://github.com/jubishop/screenr/issues/102).

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

**Implementation note:** [Issue #166](https://github.com/jubishop/screenr/issues/166)
places the reaction counts and React after the other actions on the same
line. The reaction picker and errors open beneath the whole line. The copy
status wraps in the space beside the icon, so it adds no row. Phones narrower
than 390px can wrap the title actions onto a second line.

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

**Implementation note:** [Issue #167](https://github.com/jubishop/screenr/issues/167)
removed both from the page frame in `src/components/screen.tsx`.

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

**Clarified — 2026-10-12:** The phone bottom bar uses the short labels
Circle, Find, Friends, and Account, at 12px or larger and meeting text
contrast requirements. The desktop sidebar and page headings keep the full
names. This addresses the small navigation text raised in
[issue #146](https://github.com/jubishop/screenr/issues/146). The user chose
short labels over the full names at 12px or 11px.

**Clarified — 2026-10-12:** The slim phone header also shows the viewer's
avatar beside the notification bell. It links to the viewer's profile, with
"Your profile" as its accessible name. On desktop, the sidebar keeps its
link to the viewer's profile. The user chose this so a phone has a direct
path to the viewer's own profile, which the hidden sidebar link provided
only on wider screens.

**Implementation note:** [Issue #167](https://github.com/jubishop/screenr/issues/167)
renders one navigation for both layouts in `src/components/screen.tsx`. Each
item shows the full name in the sidebar and the short label in the phone bar;
the hidden label is not exposed, so each link's name matches its visible text.
The current item has `aria-current="page"`, and Friends has
`aria-current="true"` on the invitations page. Phone pages pad their content
and give it scroll margins, so the 56px header and the 60px bar never cover
content, focused controls, or the New activity button. Focusing the header or
bar keeps the scroll position. Both clear the device's safe areas.
[Issue #170](https://github.com/jubishop/screenr/issues/170) adds the header
avatar link, shown only on phones beside the bell.

### Page titles and focus after navigation — 2026-10-12

**Decision:** Give each member page its own document title. After client
navigation, move focus to the new page's heading, and add a skip link to the
main content. The four-item navigation marks the current page with
`aria-current="page"`. This is the decided approach in
[issue #136](https://github.com/jubishop/screenr/issues/136).

**Why:** Screen-reader users heard nothing when they navigated. Every tab,
history entry, and bookmark read "Screenr · Better with friends", and
keyboard users started from the top of the sidebar after each navigation.

**Implementation note:** `memberTitle` in `src/member-routes.ts` names each
page with its heading, the title's name, or the person's display name,
followed by "· Screenr", for example "Find a title · Screenr". Until a title
or profile loads, the route names the page: "Movie", "TV show", or
"@username". `src/components/screen.tsx` renders the title, which React places
in the document head, and the member page drops the layout's title. The server
sends the title with the page, and client navigation changes it in the same
render, so Next's route announcer reads the new title aloud. A metadata title
arrives after the navigation renders, so the announcer would read only the
heading. A refresh that renames the title or person updates the title. A read
that finds the page missing titles it "Page not found"; other failed reads
keep the title. Every screen after the first in a document comes from client
navigation and focuses its heading, or the main region when an error replaces
the heading. Focus moves without scrolling, so linked entries keep their
position, and refreshes never move focus. The skip link is the first focusable
element and shows above the phone header only while focused. It focuses the
main region without changing the URL. The heading and the main region keep
focus only until they lose it and show no focus ring.
`tests/browser/page-frame.spec.ts` checks titles, focus after keyboard, link,
and Back navigation at 390px and 1366px, focus during refreshes, and the skip
link.

### Friends recommend as a Find a title tab — 2026-10-12

**Decision:** Reach the Friends recommend view from
[issue #102](https://github.com/jubishop/screenr/issues/102) through two tabs
on Find a title, beneath the search form and My services control:
Suggestions, which holds today's From your circle list, and Friends
recommend. The selected tab is part of the page URL. Searching shows results
in place of the tab content, as search results replace suggestions today. The
main navigation keeps its four items.

The My services filter applies to both tabs and to search results. When it
is on, Friends recommend lists only titles on the viewer's saved services or
free options, and marks matching services the same way as suggestions. The
view's own Movies/TV and Finished filters still apply.

**Why:** The user placed the view with the other ways of choosing something
to watch, keeping the four-item navigation. The user chose one page-wide
services filter because the control sits above both tabs.

**Rejected alternatives:** A link from the friends feed, a fifth navigation
item, and leaving the entry point open in #102.

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
| Account | Account | None. Move "Keep the same profile and friendships when you change sign-in methods." into the Sign-in methods section, and move View your profile into the Your profile section beside Edit profile. |
| Watch together | Watch together | Keep the participants and the explanation of the result order. |

Title and profile pages keep the title or person's name as the heading.

**Why:** The user accepted plain titles after the review found that the
friends feed heading, its label, and its subtitle used about 330px of a
phone screen before the first entry. Slogans such as "One you. One circle."
on Account and "What's on your mind?" on Find a title did not name the page.

**Rejected alternative:** Compacting only the friends feed would keep the
slogans on the other pages.

**Clarified — 2026-10-12:** Plain page headings are 28px on phone and 32px
on desktop. Title and profile pages keep their current, larger heading sizes
so a movie, show, or person stands out more than a utility page. The user
chose this over 24px and 28px headings and over leaving the size to the
implementer.

**Implementation note:** [Issue #167](https://github.com/jubishop/screenr/issues/167)
gives the plain headings the `page-title` class. Desktop sizes apply above
560px. The Friends heading row holds the Invite friends button. Title and
profile headers keep their line above the name: the title's kind and year,
and the profile's @username, which #170 moves below the name.

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

**Implementation note:** [Issue #168](https://github.com/jubishop/screenr/issues/168)
renders these times with `ActivityTime` in
`src/components/activity-time.tsx`, using `relativeTime` in
`src/components/client.ts`. Units count elapsed time, so daylight saving
changes don't shift them; dates and the current year follow the reader's
time zone. A reader's clock running up to a week behind shows new activity
as "now". Like other dates since
[issue #86](https://github.com/jubishop/screenr/issues/86), the server and
hydration render the UTC date and a UTC hover time, then localize once the
page is interactive. Screen and notification refreshes re-render the times.

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

**Implementation note:** [Issue #169](https://github.com/jubishop/screenr/issues/169)
renders compact entries with the `compact` mode of `FeedView` in
`src/components/feed.tsx`. A comment's author keeps Delete beside React. With
no title heading, each compact entry takes its accessible name from the
author line.

### Friend activity in the title header — 2026-10-12

**Decision:** Below the title page's Recommend and Want to watch buttons,
summarize which friends currently recommend or want to watch the title, for
example "Recommended by Maya Chen and Sam Okafor · Theo Park wants to watch".
List recommenders first. Show up to three names in each group, followed by
"and N more" when there are others. Each name scrolls to that person's entry
in the title feed. Hide the line when no friend has either action.

Include only current accepted friends, subject to the title feed's access
and blocking rules. Never list the viewer; the header buttons already show
the viewer's own choice. The user confirmed this exclusion on 2026-10-12.

**Why:** The user accepted surfacing friends' signals at the top of the page.
Today they appear only in the feed, below the availability and trailer
sections.

**Updated — 2026-10-12:** The
[profile top 10](profile-top-ten.md#show-ranks-where-friends-are-named--2026-10-12)
adds each recommender's rank beside their name and lists top 10
recommenders first, best rank first.

**Implementation note:** [Issue #169](https://github.com/jubishop/screenr/issues/169)
derives the line from the viewer's title feed with `friendActivity` in
`src/server/feed.ts`, so it uses the feed's friendship, audience, and
blocking checks. Each group lists the most recent action first.
`src/components/title-friends.tsx` renders the line, for example "Recommended
by A, B, C, and 2 more · D and E want to watch". Each name is an in-page link
to the entry, which it scrolls to and focuses. When the entry is still
waiting behind New activity, choosing the name shows the pending activity
first. The line follows refreshes, so it can name a friend's new action
before New activity is chosen.

### Watch status button on title pages — 2026-10-12

**Decision:** In the title page header, replace the Want to watch button
with a status button that shows the viewer's current status, or "+ Want to
watch" when there is none. It opens a menu with Want to watch, Watching,
Caught up (TV only), Finished, Stopped watching, and Clear status, marking
the current choice. Choosing Finished sets the last-finished date to today,
which the viewer can change or clear in the menu. Feed entries, suggestion
tiles, and other surfaces keep their one-tap "+ Want to watch" action.
[Issue #100](https://github.com/jubishop/screenr/issues/100) tracks the work.

**Why:** The user chose a single status control that fits beside Recommend
and the profile top 10 control without taking more header space.

**Rejected alternative:** A row of status chips, which takes more room,
especially on phone.

**Implementation note:** `src/components/watch-status.tsx` holds the status
button ([issue #100](https://github.com/jubishop/screenr/issues/100)). It
follows the More actions menu pattern: Enter, Space, or the arrow keys open
it; arrow keys, Home, and End move between choices; Escape returns to the
button; moving focus elsewhere or pressing outside closes it. Statuses are
menu radio items with a check beside the current one. Clear status appears
when a status exists. While a progress status or a stored date exists, a
Last finished date field below the choices offers Save date and Clear date.
Choosing Finished sends the reader's local date. While a choice saves, the
button keeps focus and does not open. The panel opens from the button and
shifts left to stay on a phone screen. A feed entry keeps its
one-tap "+ Want to watch"; a reader with another status for the title sees
that status instead, for example "✓ Watching", linked to the title page.

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

**Clarified — 2026-10-12:** Keep the `youtube.com` embed domain after the
viewer activates Play trailer. YouTube Premium removes ads from embedded
videos only for signed-in viewers whose browser allows YouTube's cookies on
other sites, and the privacy-enhanced `youtube-nocookie.com` mode is not
designed to use that session. Its privacy benefit after playback starts is
also disputed, while not loading the player before Play already provides
the main privacy gain. The user chose `youtube.com` after reviewing this
tradeoff for [issue #112](https://github.com/jubishop/screenr/issues/112).

**Implementation note:** The collapsed row holds the Play trailer button and
the Watch on YouTube link, under a "Trailer" heading kept for screen readers.
Opening the player moves focus to it. `src/components/title-trailer.tsx`
implements the section, and
[Title trailers](title-catalog.md#title-trailers) lists its checks.

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

**Implementation note:** [Issue #169](https://github.com/jubishop/screenr/issues/169)
moves the heading into `src/components/title-comment.tsx`, which owns the
button, the draft, and the composer card that opens beneath the heading.

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

**Implementation note:** The first letter is the first whole character a
reader sees, so a leading emoji, flag, or accented letter stays intact.
`src/components/initial.ts` takes it for every initial, including the poster
placeholder ([issue #144](https://github.com/jubishop/screenr/issues/144)).
Browsers without `Intl.Segmenter` fall back to the first code point.

**Implementation note:** `src/components/avatar.tsx` is the shared avatar
([issue #170](https://github.com/jubishop/screenr/issues/170)). A hash of the
user ID picks one of eight theme colors, `--avatar-0` to `--avatar-7`, and
each context sets the size through `--avatar-size`. The avatar also appears
in the profile's Friends list and every Friends page row. A profile photo
from [issue #104](https://github.com/jubishop/screenr/issues/104) covers
the initial inside this component; the initial and its color remain while the
photo loads or if it cannot load. Blocked people show the initial
([profile photos](data-and-access.md#profile-photos)).

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
display name. Label the username search button "Find" and keep it on one
line at every width; the field's placeholder already says it finds an exact
username.

**Why:** The user accepted separating relationship states after the review
found an incoming request sorted alphabetically among existing friends. Every
friend row also exposed Unfriend, which takes effect on a single tap.

**Rejected alternatives:** Keeping Unfriend on friend rows would leave a
one-tap removal beside every friend. Keeping one list would only fix the
layout problems.

**Implementation note:** [Issue #170](https://github.com/jubishop/screenr/issues/170)
shows People you may know with its empty state at every count. Blocked rows
show the name without a profile link, since blocking hides the profile.
[Issue #132](https://github.com/jubishop/screenr/issues/132) added the
Decline confirmation and the notice that Block leaves on this page.

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

**Clarified — 2026-10-12:** After a confirmed Block, open the Friends page
with a dismissible notice, for example "You blocked Maya Chen." The person
appears under Blocked people, where Unblock remains. Today the blocked
profile can no longer load and the page shows "Person not found." instead.
This resolves the blocking result in
[issue #132](https://github.com/jubishop/screenr/issues/132). The user chose
this over keeping the viewer on a minimal blocked profile, which would need a
server change to profile access.

**Implementation note:** [Issue #170](https://github.com/jubishop/screenr/issues/170)
follows the menu button pattern: Enter, Space, or the arrow keys open the
menu and focus an item; arrow keys, Home, and End move between items.
`src/components/confirmation.tsx` is the shared confirmation. Cancel takes
focus when it opens, so the reader hears the question and Enter changes
nothing. The Block message adds "This ends your friendship." or "This
removes the pending friend request." when either applies.

**Implementation note:** A confirmed Block stays open and busy until the
Friends page replaces the profile, and the profile stops refreshing once the
request starts ([issue #132](https://github.com/jubishop/screenr/issues/132)).
`src/components/page-notice.tsx` carries the notice through that client
navigation only, so a reload or later visit omits it. The notice sits beneath
the Friends heading and takes focus. Dismiss moves focus to the heading.

### Confirm other destructive actions — 2026-10-12

**Decision:** Use the same in-page confirmation as Unfriend and Block for
these actions, which act on a single tap today:

- Delete on the viewer's own comment or standalone title comment, and Remove
  on someone else's comment under the viewer's entry. For example: "Delete
  this comment? Its text will be erased."
- Decline on an incoming friend request, on the Friends page and in
  notifications.
- Revoke on an active invitation.

Each confirmation states the effect and offers the action and Cancel. Do not
use a browser dialog. This resolves the choice between confirmation and undo
in [issue #132](https://github.com/jubishop/screenr/issues/132).

**Why:** The user chose one consistent confirmation pattern for every
destructive action.

**Rejected alternatives:** An undo window would need delayed deletion or
restore support on the server. Leaving Decline as a single tap would make the
pattern inconsistent.

**Implementation note:** `ConfirmAction` in `src/components/confirmation.tsx`
runs the confirmed action and keeps a failure's message in the confirmation
([issue #132](https://github.com/jubishop/screenr/issues/132)). Each
confirmation opens beneath its action's line, in the comment, entry, Friends
row, or invitation card, while the action stays in place. Cancel returns
focus to that action. Remove asks "Remove this comment? Its text will be
erased.", Decline uses the notification's question, and Revoke asks "Revoke
this invitation? Its link will stop working."

**Implementation note:** When a successful action removes the control that
had focus, focus moves to what takes its place
([issue #191](https://github.com/jubishop/screenr/issues/191)). This covers
Delete and Remove, Revoke, and every Friends row action:

- A comment or standalone entry that keeps replies: its "Comment removed"
  placeholder.
- Accept or Send friend request: the person's new row in Friends or Sent
  requests.
- Otherwise, the next comment, entry, Friends row, or invitation in the same
  list, or the previous one when the removed item was last.
- An emptied list: the conversation's entry after its last comment, the
  activity feed after its last entry, the next Friends section's heading
  (People you may know after Blocked people), or "No active invitations."
  When an entry leaves with its last comment, the nearest entry or the feed
  takes focus.

`src/components/removal-focus.ts` chooses the targets as the write starts and
moves focus once the page no longer shows the control, unless the reader has
moved focus elsewhere. Entries, comments, Friends rows, and invitation cards
take focus without joining the Tab order. The author line and title, the
comment's author, the person, or the signups and expiry name them.

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

**Implementation note:** [Issue #168](https://github.com/jubishop/screenr/issues/168)
applied the description clamp and chevron to the shared title card in
`src/components/title-card.tsx`. Phones still hide the description, as
before. The shared icon set lives in `src/components/icons.tsx`.
[Issue #166](https://github.com/jubishop/screenr/issues/166) added the link
icon and [#167](https://github.com/jubishop/screenr/issues/167) the
navigation icons; later stages add theirs to the same module.
[Issue #170](https://github.com/jubishop/screenr/issues/170) added the more
actions and placeholder person icons. It also added the notification Accept
and Decline actions. An answered request leaves the server's list, so the
open panel keeps that row with its result.

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

**Clarified — 2026-10-12:** Base the dark palette on the brand's deep green.
Use green-tinted charcoal surfaces, with the page around `#0f1a17` and cards
one step lighter. Use warm off-white text close to the light theme's paper
color, muted sage for secondary text, and the lime accent for the current
navigation item and pressed states. The implementer chooses the exact values
within the contrast requirements. The user chose this over a neutral gray
palette and over reviewing a preview of both directions first.

**Implementation note:** [Issue #171](https://github.com/jubishop/screenr/issues/171)
defines every interface color as a custom property on `:root` in
`src/app/style.css`. A `prefers-color-scheme: dark` block overrides each one
except the shared lime accent, the brand dot, and the poster and trailer
player stand-ins. The dark page is `#0f1a17`, cards `#182621`, text
`#eeece2`, and secondary text `#9aac9f`. Primary and danger buttons invert:
a light fill labeled in the card color. The current navigation item, an open
menu button, and pressed filters keep the lime fill with deep green labels,
and pressed reactions get a lime ring. Stylesheets declare
`color-scheme: light dark`, and the head carries a theme color for each
scheme. The offline page in `public/sw.js` repeats the theme values it uses.
`tests/app/theme.test.ts` fails on a color outside the theme values, a
light value without a dark one, or a pairing below the contrast
requirements. In the dark theme, focus rings and field borders also reach
3:1; [issue #196](https://github.com/jubishop/screenr/issues/196) tracks the
light theme's. `tests/browser/contrast.spec.ts` audits text contrast and
painted colors in both schemes.
