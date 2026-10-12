"use client";
import type { ComponentProps } from "react";

// A button that is temporarily unavailable, such as while a request is
// pending, keeps keyboard focus. It sets `aria-disabled` instead of
// `disabled`, which can move focus to the page, and ignores activation,
// including form submission. Keep `disabled` for buttons that cannot work
// yet, before hydration.
export function ActionButton({
  unavailable,
  onClick,
  ...props
}: ComponentProps<"button"> & { unavailable: boolean }) {
  return (
    <button
      {...props}
      aria-disabled={unavailable}
      onClick={(event) => {
        if (unavailable) event.preventDefault();
        else onClick?.(event);
      }}
    />
  );
}
