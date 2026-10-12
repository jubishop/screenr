"use client";
import { useEffect, useReducer, useRef, useState } from "react";

// A place focus can go: an element found before the change, or the id of one
// that the change adds, such as a "Comment removed" placeholder.
export type FocusTarget = Element | string | null | undefined;

const shown = (element: Element | null | undefined): element is HTMLElement =>
  !!element?.isConnected && element.getClientRects().length > 0;

// The `selector` matches in `list` nearest to `item`: those after it, then
// those before it, closest first.
export function around(
  item: Element | null | undefined,
  list: ParentNode | null | undefined,
  selector: string,
) {
  if (!item || !list) return [];
  const items = [...list.querySelectorAll(selector)];
  const index = items.indexOf(item);
  if (index < 0) return items;
  return [...items.slice(index + 1), ...items.slice(0, index).reverse()];
}

// Pending controls keep focus (see action-button.tsx), but some successful
// actions remove their own control. Call `start` as the write begins, while
// the page still shows the reader's place, with the control and the targets
// in order of preference. After `done`, once the page no longer shows the
// control, the first target still shown takes focus, unless the reader has
// already moved focus elsewhere.
export function useRemovalFocus() {
  const plan = useRef<{
    control: Element;
    targets: FocusTarget[];
    done: boolean;
  } | null>(null);
  const [, render] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const current = plan.current;
    if (!current?.done || shown(current.control)) return;
    plan.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    for (const target of current.targets) {
      const element =
        typeof target === "string" ? document.getElementById(target) : target;
      if (shown(element)) return element.focus();
    }
  });
  const [removal] = useState(() => ({
    start(control: Element | null, targets: FocusTarget[]) {
      plan.current = control ? { control, targets, done: false } : null;
    },
    done() {
      if (plan.current) plan.current.done = true;
      render();
    },
  }));
  return removal;
}
export type RemovalFocus = ReturnType<typeof useRemovalFocus>;
