"use client";
import { useSyncExternalStore } from "react";
import { changesEachMinute, dateLabel, readerCalendar } from "./client";

const fullDate: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

// Unchanged screen refreshes don't render again, so one shared timer renders
// shown times again when their text can change. Times from the reader's
// current day, or ahead of their clock, change each minute, the format's
// smallest step, and a time from today becomes a date at midnight. Earlier
// times show a date, which changes only with the reader's time zone or
// current year, so a feed's many earlier times render again only then.
const recent = new Set<() => void>();
const dated = new Set<() => void>();
let minutes = 0;
let calendarChanges = 0;
let calendar = "";
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listeners: Set<() => void>, listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    calendar = readerCalendar();
    timer = setInterval(() => {
      minutes++;
      const current = readerCalendar();
      if (current !== calendar) {
        calendar = current;
        calendarChanges++;
        for (const notify of dated) notify();
      }
      for (const notify of recent) notify();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (recent.size || dated.size) return;
    clearInterval(timer);
    timer = undefined;
  };
}
const subscribeRecent = (listener: () => void) => subscribe(recent, listener);
const subscribeDated = (listener: () => void) => subscribe(dated, listener);
const minuteCount = () => minutes;
const calendarCount = () => calendarChanges;

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
  // UTC fields don't change with time.
  const ticking = interactive && changesEachMinute(value, Date.now());
  useSyncExternalStore(
    ticking ? subscribeRecent : subscribeDated,
    ticking ? minuteCount : calendarCount,
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
