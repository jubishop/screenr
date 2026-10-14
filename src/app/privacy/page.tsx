import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy policy · Screenr" };

// A public page, like the credits, so sign-in providers and app listings can
// link to it. A change to data practices updates this text and its effective
// date in the same change: docs/product-brief.md#public-privacy-policy--2026-10-13
export default function Privacy() {
  return (
    <main className="auth-page">
      <Link href="/" className="brand">
        screenr<span>●</span>
      </Link>
      <article className="auth-card policy">
        <h1>Privacy policy</h1>
        <p className="muted">
          Effective <time dateTime="2026-10-13">October 13, 2026</time>
        </p>
        <p>
          Screenr is a private, invite-only social app for TV and movies. Justin
          Bishop runs it as a non-commercial project. This policy covers the
          website at screenr.club and the Screenr iPhone app: what Screenr
          collects, who can see it, which services help run it, and how to
          delete it.
        </p>

        <h2>What Screenr collects</h2>
        <ul>
          <li>
            <strong>Account:</strong> your email address and the sign-in methods
            you use: email codes, Google, or Sign in with Apple. Every method
            for the same email address leads to one account.
          </li>
          <li>
            <strong>Profile:</strong> your display name, username, and optional
            photo.
          </li>
          <li>
            <strong>Friends:</strong> your friend requests, friendships, and
            blocks; the invitation you joined through; and the invitations you
            create, with who joined through each.
          </li>
          <li>
            <strong>Activity:</strong> your watch statuses and last-finished
            dates, Want to watch saves, recommendations, ratings, reviews, top
            10, posts, comments, replies, reactions, and saved streaming
            services.
          </li>
          <li>
            <strong>Notifications:</strong> your notifications and which ones
            you have read, your activity email setting, and in the iPhone app,
            your push notification settings and devices.
          </li>
          <li>
            <strong>Usage records:</strong> described under Usage measurement
            below.
          </li>
        </ul>

        <h2>Who can see it</h2>
        <p>
          Nothing members share is public. Every profile and post requires
          signing in.
        </p>
        <ul>
          <li>
            <strong>You and your current friends</strong> see your watch
            activity, ratings, reviews, recommendations, and posts, and only
            that group can comment on them. A friendship needs a request and an
            acceptance, except that joining through an invitation makes you
            friends with the person who created it.
          </li>
          <li>
            <strong>Others in a conversation</strong> see the comments you write
            on a friend&rsquo;s posts and activity, including that
            friend&rsquo;s other friends. That does not show them your own
            activity.
          </li>
          <li>
            <strong>Any signed-in member</strong> can see your display name,
            username, photo, friends list, and top 10. People you may know can
            suggest you to friends of your friends, naming your mutual friends.
          </li>
          <li>
            <strong>Friends of your friends</strong> may see anonymous counts in
            Find a title, such as &ldquo;3 friends of friends also recommend
            this.&rdquo; Your recommendations and Want to watch saves can add to
            these counts, which never name anyone.
          </li>
          <li>
            <strong>The creator of your invitation</strong> sees your display
            name and username on it.
          </li>
          <li>
            <strong>Unfriending</strong> immediately ends access to each
            other&rsquo;s posts, reviews, and threads, and hides your comments
            on each other&rsquo;s content. <strong>Blocking</strong> also hides
            each person&rsquo;s profile and content from the other, including
            comments in mutual friends&rsquo; conversations.
          </li>
        </ul>

        <h2>Services that help run Screenr</h2>
        <ul>
          <li>
            <strong>Hetzner</strong> provides the server that runs Screenr and
            holds its database.
          </li>
          <li>
            <strong>Cloudflare</strong> carries all traffic to screenr.club and
            stores Screenr&rsquo;s encrypted backups.
          </li>
          <li>
            <strong>Resend</strong> delivers sign-in codes and, if you turn them
            on, activity emails. It receives your email address and the message.
            Activity emails name the person and title involved and contain no
            comment text.
          </li>
          <li>
            <strong>TMDB</strong> (The Movie Database) supplies movie and TV
            details, images, and streaming availability, which comes from
            JustWatch. Screenr&rsquo;s server sends TMDB your title searches
            without identifying you. Your browser loads streaming service logos
            directly from TMDB.
          </li>
          <li>
            <strong>Google</strong> runs Google sign-in and shares your email
            address, name, and profile picture with Screenr. Screenr stores its
            own copy of the picture as your photo unless you choose another or
            remove it, so your browser never loads it from Google.
          </li>
          <li>
            <strong>Apple</strong> runs Sign in with Apple, which lets you share
            a Hide My Email address instead of your own; Screenr&rsquo;s email
            still reaches you through it. Apple also delivers iPhone push
            notifications. Each one carries only a notification ID, your unread
            count, and a generic &ldquo;New activity on Screenr&rdquo; alert.
            The app then fetches the details from Screenr, so comment text never
            passes through Apple.
          </li>
          <li>
            <strong>Sentry</strong> receives crash, error, and performance
            reports from the iPhone app and error reports from Screenr&rsquo;s
            server. App reports identify you only by an opaque Screenr user ID,
            with no name, email address, or IP address, and contain no
            screenshots, searches, or anything you write. Server reports contain
            only technical details, such as the type of error, where in
            Screenr&rsquo;s code it happened, and sometimes an opaque user ID.
            They never include anything you write. If you send feedback from the
            iPhone app, Sentry also receives your message, any screenshots you
            attach, and recent app logs, which contain no user content.
          </li>
          <li>
            <strong>YouTube</strong> plays trailers. Nothing loads from YouTube
            until you press Play trailer. YouTube&rsquo;s own privacy policy
            applies to its player.
          </li>
        </ul>

        <h2>Usage measurement</h2>
        <p>
          Screenr measures how it is used in its own database, with no
          third-party analytics. It records:
        </p>
        <ul>
          <li>
            Each day you use Screenr, with whether you used the website, the
            iPhone app, or both.
          </li>
          <li>
            Each Want to watch save, with the title, the date, where in Screenr
            you saved it, and whether a friend was recommending it at the time,
            never which friend. Screenr also notes whether you later marked the
            title Watching, Caught up, or Finished.
          </li>
        </ul>
        <p>
          The usage report shows only weekly totals, never figures for
          individual members, and none of these records go to third parties.
          They are deleted after 12 months.
        </p>

        <h2>Cookies and sign-in</h2>
        <p>
          The website uses a cookie to keep you signed in and another to
          remember an invitation while you join. The iPhone app keeps its
          sign-in token in the iPhone&rsquo;s Keychain. Screenr&rsquo;s sign-in
          records the IP address and browser of each session, and uses IP
          addresses to limit repeated sign-in requests. Screenr uses no
          advertising or tracking cookies.
        </p>

        <h2>No ads or selling</h2>
        <p>
          Screenr shows no ads, does not sell or rent your information, and uses
          no third-party analytics or advertising trackers.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>
            Change your display name, username, or photo, or remove your photo,
            in Account.
          </li>
          <li>
            Delete your comments and posts, withdraw a recommendation or status,
            unfriend someone, or block them.
          </li>
          <li>
            Turn activity emails on or off in Account. In the iPhone app, choose
            which kinds of push notifications you receive.
          </li>
        </ul>

        <h2>Deleting your account</h2>
        <p>
          Delete your account from Account on the website. Screenr first emails
          you a sign-in code to confirm it&rsquo;s you, then asks you to confirm
          the deletion. Deletion from You &rarr; Settings in the iPhone app is
          coming soon; until then, use the website or email{" "}
          <a href="mailto:screenr@jubishop.com">screenr@jubishop.com</a>.
        </p>
        <p>
          Deleting an account is permanent. It erases your sessions and push
          devices, profile and photo, friendships, invitations, blocks,
          recommendations, watch statuses, reviews, top 10, reactions,
          notifications, and usage records. Your posts and reviews are removed
          along with their conversations. Your comments are erased; one that has
          replies becomes &ldquo;Comment removed&rdquo; so the replies remain.
          If you used Sign in with Apple, Screenr also revokes its access with
          Apple.
        </p>
        <p>
          Deleted information stays in Screenr&rsquo;s encrypted backups until
          they expire. Backups keep seven daily and four weekly copies, so this
          takes about a month.
        </p>

        <h2>Children</h2>
        <p>Screenr is not meant for children under 13.</p>

        <h2>Changes</h2>
        <p>
          When this policy changes, the new version will appear on this page
          with a new effective date.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about your information or this policy:{" "}
          <a href="mailto:screenr@jubishop.com">screenr@jubishop.com</a>
        </p>

        <Link className="text-button" href="/">
          Back to Screenr →
        </Link>
      </article>
    </main>
  );
}
