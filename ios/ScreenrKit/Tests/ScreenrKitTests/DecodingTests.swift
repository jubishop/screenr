import Foundation
import Testing

@testable import ScreenrKit

struct DecodingTests {
  private let noon = Date(timeIntervalSince1970: 1_791_892_800)

  @Test(arguments: [
    "2026-10-13T12:00:00.000Z",
    "2026-10-13T12:00:00.000000+00:00",
    "2026-10-13T12:00:00+00:00",
    "2026-10-13T12:00:00Z",
    "2026-10-13T12:00:00.0+00:00",
    "2026-10-13T05:00:00-07:00",
    "2026-10-13T05:00:00.000-0700",
    "2026-10-13 12:00:00+00",
  ])
  func parsesEveryServerTimestampForm(_ text: String) {
    #expect(ServerTimestamp.date(from: text) == noon)
  }

  @Test func keepsFractionsOfAnyLength() throws {
    let date = try #require(ServerTimestamp.date(from: "2026-10-13T12:00:00.123456789Z"))
    #expect(abs(date.timeIntervalSince(noon) - 0.123456789) < 0.000001)
    let short = try #require(ServerTimestamp.date(from: "2026-10-13T12:00:00.5+00:00"))
    #expect(short.timeIntervalSince(noon) == 0.5)
  }

  @Test func countsDaysAcrossLeapYearsAndTheEpoch() {
    #expect(ServerTimestamp.date(from: "1970-01-01T00:00:00Z") == Date(timeIntervalSince1970: 0))
    #expect(
      ServerTimestamp.date(from: "2024-02-29T00:00:00Z")
        == Date(timeIntervalSince1970: 1_709_164_800)
    )
    #expect(
      ServerTimestamp.date(from: "1969-12-31T23:59:59Z") == Date(timeIntervalSince1970: -1)
    )
  }

  @Test(arguments: [
    "", "2026-10-13", "2026-10-13T12:00:00", "2026-10-13T12:00:00.Z",
    "2026-13-13T12:00:00Z", "2026-10-13T12:00:00Zjunk", "2026-10-13T24:00:00Z",
  ])
  func rejectsOtherText(_ text: String) {
    #expect(ServerTimestamp.date(from: text) == nil)
  }

  @Test func decodesUnknownEnumValuesAsUnknown() throws {
    let decoder = ScreenrJSON.decoder()
    let kinds = try decoder.decode(
      [ReactionKind].self,
      from: Data(#"["like", "applause"]"#.utf8)
    )
    #expect(kinds == [.like, .unknown])
    #expect(
      try decoder.decode([WatchStatus].self, from: Data(#"["caught_up", "paused"]"#.utf8))
        == [.caughtUp, .unknown]
    )
    #expect(try decoder.decode(NotificationKind.self, from: Data(#""mention""#.utf8)) == .unknown)
  }

  @Test func decodesAnUnknownScreenKind() throws {
    let json = #"""
      {"kind": "watch-party", "user": {"user_id": "user-alice", "username": "alice",
      "display_name": "Alice Park", "photo": null}, "unreadNotifications": 2, "guests": []}
      """#
    let screen = try ScreenrJSON.decoder().decode(Screen.self, from: Data(json.utf8))
    #expect(screen.content == .unknown(kind: "watch-party"))
    #expect(screen.user.displayName == "Alice Park")
    #expect(screen.unreadNotifications == 2)
  }

  @Test func ignoresFieldsTheServerAdds() throws {
    let json = #"""
      {"id": "movie:101", "kind": "movie", "tmdb_id": 101, "name": "Night Crossing",
      "overview": "", "poster_path": null, "release_date": "2024-03-08", "runtime": 118}
      """#
    let title = try ScreenrJSON.decoder().decode(Title.self, from: Data(json.utf8))
    #expect(title.tmdbId == 101)
    #expect(title.posterPath == nil)
  }

  @Test func roundTripsJSONValues() throws {
    let value: JSONValue = [
      "text": "a/b", "count": 3, "ratio": .number(0.5), "on": true, "none": .null,
      "list": [1, "two"],
    ]
    let data = try ScreenrJSON.encoder().encode(value)
    #expect(try JSONDecoder().decode(JSONValue.self, from: data) == value)
    #expect(String(decoding: data, as: UTF8.self).contains(#""count":3"#))
  }
}
