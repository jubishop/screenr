"use client";
import { dateLabel } from "./client";

const fullDate: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

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
