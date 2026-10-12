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
