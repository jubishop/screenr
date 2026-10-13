"use client";
import { useSyncExternalStore } from "react";
import { dateLabel } from "./client";

const fullDate: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

// Unchanged screen refreshes don't render again, so one shared timer renders
// every shown time again each minute, the format's smallest step.
const listeners = new Set<() => void>();
let minutes = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    minutes++;
    for (const notify of listeners) notify();
  }, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearInterval(timer);
    timer = undefined;
  };
}

// A feed entry, comment, or notification time, such as "2h", with the full
// local date and time on hover. Both stay in UTC fields until the page is
// interactive, so server and hydration markup match.
export function ActivityTime({
  value,
  interactive,
  className,
}: {
  value: string;
  interactive: boolean;
  className?: string;
}) {
  useSyncExternalStore(
    subscribe,
    () => minutes,
    () => 0,
  );
  return (
    <time
      className={className}
      dateTime={value}
      title={dateLabel(value, interactive, fullDate)}
    >
      {dateLabel(value, interactive, "relative")}
    </time>
  );
}
