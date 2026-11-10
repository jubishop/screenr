import type { ReactNode } from "react";

// Screenr's own inline SVG icon set. Add icons here instead of adding an icon
// dependency.
const icons = {
  link: (
    <g transform="rotate(-45 12 12)">
      <path d="M10 8H7a4 4 0 0 0 0 8h3" />
      <path d="M14 8h3a4 4 0 0 1 0 8h-3" />
      <path d="M8.5 12h7" />
    </g>
  ),
  // Navigation: Your circle, Find a title, Friends, and Account.
  circle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </>
  ),
  friends: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6" />
      <path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.2 18.4a6.5 6.5 0 0 1 11.6 0" />
    </>
  ),
  // More actions menu button.
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  // Ends a title list row that opens a page inside Screenr.
  chevron: <path d="m9 5 7 7-7 7" />,
  // A menu button that opens beneath it, such as the watch status.
  expand: <path d="m7 10 5 5 5-5" />,
  // Profile top 10 editing: Edit, Move up, Move down, and Remove.
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="m13 7 4 4" />
    </>
  ),
  up: <path d="M12 19V5m-6 6 6-6 6 6" />,
  down: <path d="M12 5v14m-6-6 6 6 6-6" />,
  remove: <path d="M6 6l12 12M18 6 6 18" />,
  // Report a post, comment, or review.
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4.5 2 4.5H5" />
    </>
  ),
  // Placeholder avatar for a person who is not available.
  person: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  // Feed entry actions: Recommend, Rate or review, React, Comment, and Reply.
  recommend: (
    <>
      <rect x="3" y="10.5" width="4" height="9.5" rx="1" />
      <path d="M7 10.5 10.8 3.6a1.9 1.9 0 0 1 3.4 1.5L13.4 9.5H19a2 2 0 0 1 2 2.4l-1.4 6.5a2 2 0 0 1-2 1.6H7" />
    </>
  ),
  review: (
    <path d="M12 3l2.3 6.3 6.7.3-5.3 4.1 1.9 6.5L12 16.4l-5.6 3.8 1.9-6.5L3 9.6l6.7-.3Z" />
  ),
  react: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  comment: (
    <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
  ),
  reply: (
    <>
      <path d="m9 15-5-5 5-5" />
      <path d="M4 10h9a7 7 0 0 1 7 7v2" />
    </>
  ),
  // A feed entry's watch status: none yet, then each status.
  "no-status": (
    <>
      <path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4-6 4v-16a1 1 0 0 1 1-1Z" />
      <path d="M12 7.5v6M9 10.5h6" />
    </>
  ),
  want_to_watch: (
    <path d="M7 3.5h10a1 1 0 0 1 1 1v16l-6-4-6 4v-16a1 1 0 0 1 1-1Z" />
  ),
  watching: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.8v6.4l5-3.2Z" fill="currentColor" />
    </>
  ),
  caught_up: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.8 8.8v6.4l4.6-3.2Z" fill="currentColor" />
      <path d="M15.6 8.8v6.4" />
    </>
  ),
  finished: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16 9.7" />
    </>
  ),
  stopped: (
    <>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="0.5" fill="currentColor" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

// A filled icon marks a choice the reader has made, such as Recommended.
export function Icon({
  name,
  filled = false,
}: {
  name: IconName;
  filled?: boolean;
}) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icons[name]}
    </svg>
  );
}
