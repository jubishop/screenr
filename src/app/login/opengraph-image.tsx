import { ImageResponse } from "next/og";

export const alt =
  "A movie screen and conversation bubbles. Better with friends.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: "#f7f6f0",
      }}
    >
      <svg width="1200" height="630" viewBox="0 0 1200 630">
        <circle cx="600" cy="315" r="265" fill="#e9eddc" />
        <rect x="302" y="134" width="596" height="362" rx="32" fill="#163c34" />
        <rect x="326" y="158" width="548" height="314" rx="14" fill="#28554a" />
        <circle cx="600" cy="315" r="82" fill="#d9eb85" />
        <path d="M582 273 L641 315 L582 357 Z" fill="#163c34" />
        <path
          d="M202 72 H384 Q408 72 408 96 V191 Q408 215 384 215 H291 L248 251 V215 H202 Q178 215 178 191 V96 Q178 72 202 72 Z"
          fill="#d9eb85"
        />
        <circle cx="245" cy="144" r="10" fill="#163c34" />
        <circle cx="293" cy="144" r="10" fill="#163c34" />
        <circle cx="341" cy="144" r="10" fill="#163c34" />
        <path
          d="M816 383 H998 Q1022 383 1022 407 V502 Q1022 526 998 526 H952 V562 L909 526 H816 Q792 526 792 502 V407 Q792 383 816 383 Z"
          fill="#d9eb85"
        />
        <path
          d="M908 411 L921 437 L950 441 L929 462 L934 491 L908 477 L882 491 L887 462 L866 441 L895 437 Z"
          fill="#163c34"
        />
      </svg>
    </div>,
    size,
  );
}
