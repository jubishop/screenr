"use client";
import { flushSync } from "react-dom";

// On phone, the sticky header and the bottom navigation span the page width
// and cover the content beneath them.
function covering(selector: string) {
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  return rect && rect.width >= document.documentElement.clientWidth - 1
    ? rect
    : undefined;
}

export function preservePosition(update: () => void) {
  const topEdge = covering(".sidebar")?.bottom ?? 0;
  const bottomEdge = covering(".main-nav")?.top ?? window.innerHeight;
  const anchor = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-comment-id], [data-composer-id], [data-item-heading]",
    ),
  ).find((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.bottom > topEdge && bounds.top < bottomEdge;
  });
  const top = anchor?.getBoundingClientRect().top;
  flushSync(update);
  if (anchor?.isConnected && top !== undefined)
    window.scrollBy(0, anchor.getBoundingClientRect().top - top);
}
