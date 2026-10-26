import { releaseCalendar } from "../../src/server/title-release";

// A US calendar date `days` from today, as the release status counts days.
export function fromToday(days: number) {
  const date = new Date(`${releaseCalendar.today()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// TMDB details for the browser catalog's "release dates" search: a movie in
// US theaters with its digital release ahead, and a show that premieres soon.
// Dates move with today, so the labels stay current.
export function releaseTitles() {
  return [
    {
      id: 987700,
      media_type: "movie",
      title: "Lanterns at Dusk",
      overview: "A fictional movie that is in theaters now.",
      release_date: fromToday(-10),
      poster_path: null,
      release_dates: {
        results: [
          {
            iso_3166_1: "US",
            release_dates: [
              { type: 3, release_date: `${fromToday(-10)}T00:00:00.000Z` },
              { type: 4, release_date: `${fromToday(30)}T00:00:00.000Z` },
            ],
          },
        ],
      },
    },
    {
      id: 987701,
      media_type: "tv",
      name: "The Tidewater Hour",
      overview: "A fictional show that has not premiered yet.",
      first_air_date: fromToday(12),
      poster_path: null,
      networks: [{ id: 213, name: "Netflix", origin_country: "" }],
      seasons: [{ season_number: 1, air_date: fromToday(12) }],
    },
  ];
}
