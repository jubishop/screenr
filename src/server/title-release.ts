import type { ReleaseDate, TitleRelease } from "../shared";

// US release data as stored with a title's details: only the dates the
// release status uses (docs/title-availability.md#release-status-implementation).
// Every date is a US calendar date, YYYY-MM-DD.
export type StoredRelease =
  // A movie's US limited and wide theatrical dates, and its digital dates.
  | { theatrical: string[]; digital: string[] }
  // A show's premiere, the US or worldwide network it premieres on, and its
  // seasons' first air dates.
  | {
      premiere: string | null;
      network: string | null;
      seasons: { number: number; date: string }[];
    };

// A movie is in theaters from its latest US theatrical release through the
// following 44 days.
export const theatricalWindowDays = 45;

// The status changes at midnight in the latest mainland US time zone, so no
// label says a title is out before its release day there. Tests replace
// `today` to fix the date.
const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const releaseCalendar = {
  today(): string {
    const parts = pacific.formatToParts(new Date());
    const part = (type: string) =>
      parts.find((item) => item.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// TMDB sends dates as `2026-11-21` or `2026-11-21T00:00:00.000Z`. Only the
// calendar date counts; converting the instant to a time zone would move it
// a day.
function calendarDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value)?.[1];
  if (!date) return null;
  const time = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(time.getTime()) &&
    time.toISOString().slice(0, 10) === date
    ? date
    : null;
}
// Season 0 holds specials, which have no premiere.
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const sortedDates = (dates: (string | null)[]) =>
  [...new Set(dates.filter((date): date is string => !!date))].sort();

// The release data in a details response, or null when a movie's response
// has no usable release dates. A show's dates come from its details: a
// missing date or network means no announcement. Only the US result of a
// movie counts, and a show counts only on a US or worldwide network, such as
// a streaming service; another country's dates never stand in.
export function parseRelease(
  raw: Record<string, unknown>,
  kind: "movie" | "tv",
): StoredRelease | null {
  if (kind === "movie") {
    const releases = raw.release_dates;
    if (!isRecord(releases) || !Array.isArray(releases.results)) return null;
    const us = releases.results.find(
      (result) => isRecord(result) && result.iso_3166_1 === "US",
    );
    if (us === undefined) return { theatrical: [], digital: [] };
    if (!isRecord(us) || !Array.isArray(us.release_dates)) return null;
    const dates = (types: number[]) =>
      sortedDates(
        (us.release_dates as unknown[]).map((release) =>
          isRecord(release) &&
          typeof release.type === "number" &&
          types.includes(release.type)
            ? calendarDate(release.release_date)
            : null,
        ),
      );
    // TMDB types: 2 limited theatrical, 3 theatrical, 4 digital.
    return { theatrical: dates([2, 3]), digital: dates([4]) };
  }
  const network = Array.isArray(raw.networks)
    ? raw.networks.find(
        (item) =>
          isRecord(item) &&
          (item.origin_country === "US" || item.origin_country === "") &&
          typeof item.name === "string" &&
          item.name.trim(),
      )
    : undefined;
  if (!isRecord(network)) return { premiere: null, network: null, seasons: [] };
  // A season's air date is its first episode's. The next episode stands in
  // for a season premiere TMDB has not dated yet.
  const seasons = new Map<number, string>();
  for (const season of Array.isArray(raw.seasons) ? raw.seasons : []) {
    const date = isRecord(season) && calendarDate(season.air_date);
    if (date && positive(season.season_number))
      seasons.set(season.season_number, date);
  }
  const next = raw.next_episode_to_air;
  if (
    isRecord(next) &&
    next.episode_number === 1 &&
    positive(next.season_number) &&
    !seasons.has(next.season_number)
  ) {
    const date = calendarDate(next.air_date);
    if (date) seasons.set(next.season_number, date);
  }
  return {
    premiere: calendarDate(raw.first_air_date) ?? seasons.get(1) ?? null,
    network: String(network.name).trim(),
    seasons: [...seasons]
      .map(([number, date]) => ({ number, date }))
      .sort((a, b) => a.number - b.number),
  };
}

const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
// "Nov 21", with the year when it is not the current year, as for feed times.
function dayLabel(date: string, today: string) {
  const [year, month, day] = date.split("-").map(Number);
  return `${months[month - 1]} ${day}${date.slice(0, 4) === today.slice(0, 4) ? "" : `, ${year}`}`;
}
const days = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
  86_400_000;
const dateList = (value: unknown) =>
  Array.isArray(value)
    ? sortedDates(value.map((date) => calendarDate(date)))
    : [];

// The status on `today`, derived when a screen is sent so a stored row never
// shows an old status. A movie shows In theaters, its next theatrical date
// when it is not in theaters, and its first digital date while that is still
// ahead; a later digital date is often a streaming service's arrival, which
// Where to watch covers. A show shows its premiere until it airs, then its
// next season premiere. Weekly episode dates never appear.
export function titleRelease(
  kind: "movie" | "tv",
  stored: StoredRelease | null | undefined,
  today = releaseCalendar.today(),
): TitleRelease {
  if (!isRecord(stored))
    return { status: "unavailable", in_theaters: false, upcoming: [] };
  const upcoming: ReleaseDate[] = [];
  const add = (type: ReleaseDate["kind"], date: string, text: string) =>
    upcoming.push({
      kind: type,
      date,
      label: `${text} ${dayLabel(date, today)}`,
    });
  if (kind === "movie" && "theatrical" in stored) {
    const theatrical = dateList(stored.theatrical);
    const latest = theatrical.filter((date) => date <= today).at(-1);
    const inTheaters = !!latest && days(latest, today) < theatricalWindowDays;
    const nextTheatrical = theatrical.find((date) => date > today);
    if (!inTheaters && nextTheatrical)
      add("theatrical", nextTheatrical, "In theaters");
    const firstDigital = dateList(stored.digital)[0];
    if (firstDigital && firstDigital > today)
      add("digital", firstDigital, "Digital");
    upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { status: "ok", in_theaters: inTheaters, upcoming };
  }
  if (kind === "tv" && "seasons" in stored) {
    const premiere = calendarDate(stored.premiere);
    if (premiere && premiere > today)
      upcoming.push({
        kind: "premiere",
        date: premiere,
        label: `Premieres ${dayLabel(premiere, today)}${stored.network ? ` on ${stored.network}` : ""}`,
      });
    else if (premiere) {
      const next = (Array.isArray(stored.seasons) ? stored.seasons : [])
        .flatMap(({ number, date }) => {
          const day = calendarDate(date);
          return day && day > today ? [{ number, date: day }] : [];
        })
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
      if (next)
        add("season_premiere", next.date, `Season ${next.number} premieres`);
    }
    return { status: "ok", in_theaters: false, upcoming };
  }
  return { status: "unavailable", in_theaters: false, upcoming: [] };
}
