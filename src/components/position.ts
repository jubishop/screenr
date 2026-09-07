"use client";
import { flushSync } from "react-dom";

export function preservePosition(update: () => void) {
  const anchor = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-comment-id], [data-composer-id], [data-item-heading]",
    ),
  ).find((node) => {
    const bounds = node.getBoundingClientRect();
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    const topEdge =
      sidebar && sidebar.right >= window.innerWidth - 1 ? sidebar.bottom : 0;
    return bounds.bottom > topEdge && bounds.top < window.innerHeight;
  });
  const top = anchor?.getBoundingClientRect().top;
  flushSync(update);
  if (anchor?.isConnected && top !== undefined)
    window.scrollBy(0, anchor.getBoundingClientRect().top - top);
}
