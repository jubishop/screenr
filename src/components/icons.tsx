import type { ReactNode } from "react";

// Screenr's own inline SVG icon set. Add icons here instead of adding an icon
// dependency. Icons are decorative: the control that shows one names itself.
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
  // Placeholder avatar for a person who is not available.
  person: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icons[name]}
    </svg>
  );
}
