import Foundation

// The `/api/screenr/<action>` requests, one function per action. Each takes
// the action's fields and returns a request for its response type.

extension APIRequest where Response == Screen {
  // The view model for a member path, such as `/`, `/titles/tv/201`, or
  // `/people/ben`. Repeated reads of a path send its ETag, and an unchanged
  // screen returns the cached copy. The first read after launch or a return
  // to the foreground is the app's visit.
  public static func screen(path: String) -> Self {
    APIRequest(
      method: .get,
      endpoint: .action("screen"),
      query: ["path": path],
      visit: .whenDue,
      route: "/api/screenr/screen?path=" + MemberPath.pattern(of: path)
    )
  }
}

extension APIRequest where Response == [ViewingTitle] {
  public static func search(_ text: String) -> Self {
    APIRequest(method: .get, endpoint: .action("search"), query: ["q": text])
  }
}

extension APIRequest where Response == TitleResolution {
  // The share extension's link and text, either of which may be empty. Logs
  // name only the route, never what was shared.
  public static func resolveTitle(url: String, text: String) -> Self {
    var query: [String: String] = [:]
    if !url.isEmpty { query["url"] = url }
    if !text.isEmpty { query["text"] = text }
    return APIRequest(method: .get, endpoint: .action("resolve-title"), query: query)
  }
}

extension APIRequest where Response == SeasonList {
  // The TV discussion composer's Season picker.
  public static func seasons(title: String) -> Self {
    APIRequest(method: .get, endpoint: .action("seasons"), query: ["title": title])
  }
}

extension APIRequest where Response == EpisodeList {
  public static func episodes(title: String, season: Int) -> Self {
    APIRequest(
      method: .get,
      endpoint: .action("episodes"),
      query: ["title": title, "season": String(season)]
    )
  }
}

public enum NotificationFilter: Hashable, Sendable {
  case all
  case unread
}

extension APIRequest where Response == NotificationPage {
  // The newest page, or the page before `before`. Later pages pass the first
  // page's `through`, so they leave out newer arrivals.
  public static func notifications(
    before: String? = nil,
    through: String? = nil,
    filter: NotificationFilter = .all
  ) -> Self {
    var query: [String: String] = [:]
    query["before"] = before
    query["through"] = through
    if filter == .unread { query["unread"] = "true" }
    return APIRequest(method: .get, endpoint: .action("notifications"), query: query)
  }
}

extension APIRequest where Response == NotificationLookup {
  // One notification, for the push extension's alert. Reading marks nothing.
  public static func notification(id: String) -> Self {
    APIRequest(method: .get, endpoint: .action("notification"), query: ["id": id])
  }
}

extension APIRequest where Response == NotificationTarget {
  public static func readNotification(id: String) -> Self {
    .write("read-notification", ["id": .string(id)])
  }
}

public enum FriendRequestResponse: String, Hashable, Sendable {
  case accept
  case decline
}

public enum RelationshipAction: String, Hashable, Sendable {
  case request
  case accept
  // Unfriends, or withdraws or declines a pending request.
  case remove
  case block
  case unblock
}

// A change to the viewer's top 10. Adding to a full list names the listed
// title it replaces; moving names the new rank, from 1.
public enum TopTenChange: Hashable, Sendable {
  case add(replacing: String? = nil)
  case remove
  case up
  case down
  case move(rank: Int)
}

// The title actions that `activity` sets.
public enum TitleActivity: String, Hashable, Sendable {
  case recommended
  case wantToWatch = "want_to_watch"
}

// Where a member saved a title to Want to watch, for usage telemetry.
public enum SaveSurface: String, Hashable, Sendable {
  // The action on a friend's active Recommend entry.
  case friendRecommendation = "friend_recommendation"
  // The action on any other friend's feed entry.
  case friendEntry = "friend_entry"
  case friendsRecommend = "friends_recommend"
  // A title page opened from a suggestion naming a recommending friend.
  case suggestionRecommendation = "suggestion_recommendation"
  // A title page opened from another suggestion.
  case suggestion
  // A title page reached any other way.
  case title
  // A title page opened from Watch together.
  case watchTogether = "watch_together"

  // The surfaces that open title pages with `?from=`, or nil for any other
  // value, which a title page ignores.
  init?(titleOrigin: String?) {
    guard let titleOrigin, let surface = SaveSurface(rawValue: titleOrigin),
      [.friendsRecommend, .suggestionRecommendation, .suggestion, .watchTogether].contains(surface)
    else { return nil }
    self = surface
  }
}

extension APIRequest where Response == SetupDetails {
  // What first-time setup starts from. It works before the profile exists.
  public static var setupDetails: Self {
    APIRequest(method: .get, endpoint: .action("setup-details"))
  }
}

extension APIRequest where Response == Acknowledgement {
  // Completes a new member's profile. `invitation` is the token of the link
  // they joined through.
  public static func setup(name: String, username: String, invitation: String? = nil) -> Self {
    .write(
      "setup",
      ["name": .string(name), "username": .string(username)],
      invitation: invitation
    )
  }

  // Marks every notification up to `through` read.
  public static func readNotifications(through: String) -> Self {
    .write("read-notifications", ["through": .string(through)])
  }

  // `notification` is the friend request notification's ID.
  public static func respondToFriendRequest(
    notification: String,
    _ response: FriendRequestResponse
  ) -> Self {
    .write(
      "respond-friend-request",
      ["id": .string(notification), "action": .string(response.rawValue)]
    )
  }

  public static func revokeInvite(id: String) -> Self {
    .write("revoke-invite", ["id": .string(id)])
  }

  // `target` is the other person's user ID.
  public static func relationship(target: String, _ action: RelationshipAction) -> Self {
    .write("relationship", ["target": .string(target), "action": .string(action.rawValue)])
  }

  // Changes the last-finished date, `YYYY-MM-DD`, or clears it with nil.
  public static func finishedDate(title: String, date: String?) -> Self {
    .write("finished-date", ["title": .string(title), "date": .nullable(date)])
  }

  public static func removeReview(title: String) -> Self {
    .write("remove-review", ["title": .string(title)])
  }

  public static func topTen(title: String, _ change: TopTenChange) -> Self {
    let fields: [String: JSONValue?] =
      switch change {
      case .add(let replacing): ["change": "add", "replace": .optional(replacing)]
      case .remove: ["change": "remove"]
      case .up: ["change": "up"]
      case .down: ["change": "down"]
      case .move(let rank): ["change": "move", "rank": .integer(rank)]
      }
    return .write("top-ten", fields.merging(["title": .string(title)]) { field, _ in field })
  }

  public static func removeComment(id: String) -> Self {
    .write("remove-comment", ["id": .string(id)])
  }

  // Sets or, with a nil kind, clears the viewer's reaction to an entry or to
  // one of its replies.
  public static func reaction(item: String, reply: String? = nil, kind: ReactionKind?) -> Self {
    .write(
      "reaction",
      [
        "item": .string(item),
        "reply": .optional(reply),
        "kind": .nullable(kind?.rawValue),
      ]
    )
  }
}

extension APIRequest where Response == Acknowledgement {
  // Permanently deletes the signed-in account, then removes the token. The
  // session must come from a sign-in in the last ten minutes; an older one
  // gets 403, and the member signs in again first.
  public static var deleteAccount: Self {
    APIRequest(
      method: .post,
      endpoint: .action("delete-account"),
      body: .json([:]),
      sessionChange: .signOut
    )
  }
}

extension APIRequest where Response == ActivityEmailSetting {
  public static func activityEmail(enabled: Bool) -> Self {
    .write("activity-email", ["enabled": .bool(enabled)])
  }
}

// The APNs environment a device token belongs to: Screenr Dev's is sandbox.
public enum PushEnvironment: String, Hashable, Sendable {
  case sandbox
  case production
}

extension APIRequest where Response == Acknowledgement {
  // Registers this session's APNs device token. `topic` is the app's bundle
  // ID, and `build` its build number.
  public static func registerPushDevice(
    token: String,
    environment: PushEnvironment,
    topic: String,
    build: Int
  ) -> Self {
    .write(
      "push-device",
      [
        "action": "register", "token": .string(token),
        "environment": .string(environment.rawValue), "topic": .string(topic),
        "build": .integer(build),
      ]
    )
  }

  public static func removePushDevice(token: String) -> Self {
    .write("push-device", ["action": "remove", "token": .string(token)])
  }
}

extension APIRequest where Response == SavedPushSettings {
  // Turns push kinds on or off. Kinds left nil keep their values.
  public static func pushSettings(
    friendRequest: Bool? = nil,
    friendAccepted: Bool? = nil,
    comment: Bool? = nil,
    reply: Bool? = nil
  ) -> Self {
    .write(
      "push-settings",
      [
        "friendRequest": .optional(friendRequest), "friendAccepted": .optional(friendAccepted),
        "comment": .optional(comment), "reply": .optional(reply),
      ]
    )
  }
}

extension APIRequest where Response == SavedServices {
  public static func streamingServices(_ serviceIds: [String]) -> Self {
    .write("streaming-services", ["serviceIds": .array(serviceIds.map { .string($0) })])
  }
}

extension APIRequest where Response == Person {
  public static func displayName(_ name: String) -> Self {
    .write("display-name", ["name": .string(name)])
  }

  public static func profile(name: String, username: String) -> Self {
    .write("profile", ["name": .string(name), "username": .string(username)])
  }
}

extension APIRequest where Response == PhotoVersion {
  // A square JPEG of at most 200 KB; the web sends 512×512.
  public static func uploadPhoto(jpeg: Data) -> Self {
    APIRequest(
      method: .post,
      endpoint: .action("photo"),
      body: .upload(jpeg, contentType: "image/jpeg")
    )
  }

  public static var removePhoto: Self { .write("remove-photo", [:]) }

  public static var googlePhoto: Self { .write("google-photo", [:]) }
}

extension APIRequest where Response == Data {
  // A person's profile photo, as a person's `photo` names its version. The
  // server shows it only to signed-in people who can see the profile.
  public static func photo(userId: String, version: String) -> Self {
    APIRequest(
      method: .get,
      endpoint: .photo(userId: userId, version: version),
      route: "/api/photos/:user/:version"
    )
  }
}

extension APIRequest where Response == CreatedInvitation {
  public static func invite(limit: Int = 1) -> Self {
    .write("invite", ["limit": .integer(limit)])
  }
}

extension APIRequest where Response == EntryID {
  public static func activity(
    title: String,
    _ activity: TitleActivity,
    value: Bool,
    surface: SaveSurface? = nil
  ) -> Self {
    .write(
      "activity",
      [
        "title": .string(title),
        "field": .string(activity.rawValue),
        "value": .bool(value),
        "surface": .optional(surface?.rawValue),
      ]
    )
  }

  // `rating` is whole stars from 1 to 5, or nil for a review with only text.
  public static func review(title: String, rating: Int?, body: String, spoiler: Bool) -> Self {
    .write(
      "review",
      [
        "title": .string(title), "rating": .nullable(rating), "body": .string(body),
        "spoiler": .bool(spoiler),
      ]
    )
  }

  // A discussion on a title, optionally labeled with a TV season or episode.
  public static func titleComment(
    title: String,
    body: String,
    spoiler: Bool,
    season: Int? = nil,
    episode: Int? = nil
  ) -> Self {
    .write(
      "title-comment",
      [
        "title": .string(title), "body": .string(body), "spoiler": .bool(spoiler),
        "season": .optional(season), "episode": .optional(episode),
      ]
    )
  }

  // A post without a title, on the friends feed.
  public static func discussionPost(body: String, spoiler: Bool) -> Self {
    .write("discussion-post", ["body": .string(body), "spoiler": .bool(spoiler)])
  }

  // A reply in an entry's discussion. `conversation` is the entry's `id`, and
  // `replyTo` the comment it answers.
  public static func comment(
    conversation: String,
    body: String,
    spoiler: Bool,
    replyTo: String? = nil
  ) -> Self {
    .write(
      "comment",
      [
        "conversation": .string(conversation), "body": .string(body),
        "spoiler": .bool(spoiler), "replyTo": .optional(replyTo),
      ]
    )
  }
}

extension APIRequest where Response == SavedWatchStatus {
  // Sets the viewer's status for a title, or clears it with nil. Finished
  // records `finishedOn` (`YYYY-MM-DD`), or today in Pacific time.
  public static func watchStatus(
    title: String,
    _ status: WatchStatus?,
    finishedOn: String? = nil,
    surface: SaveSurface? = nil
  ) -> Self {
    .write(
      "watch-status",
      [
        "title": .string(title),
        "status": .nullable(status?.rawValue),
        "finishedOn": .optional(finishedOn),
        "surface": .optional(surface?.rawValue),
      ]
    )
  }
}

extension APIRequest {
  static func write(
    _ action: String,
    _ body: [String: JSONValue?],
    invitation: String? = nil
  ) -> Self {
    APIRequest(
      method: .post,
      endpoint: .action(action),
      body: .json(.members(body)),
      invitation: invitation
    )
  }
}

// Member paths reduced to their route patterns, which name no person, title,
// or search, for logs and error reports.
enum MemberPath {
  static func pattern(of path: String) -> String {
    let parts = path.prefix { $0 != "?" && $0 != "#" }.split(separator: "/")
    switch parts.count {
    case 0: return "/"
    case 1 where ["search", "people", "invites", "account", "watch-together"].contains(parts[0]):
      return "/\(parts[0])"
    case 2 where parts[0] == "people": return "/people/:username"
    case 2 where parts[0] == "conversations": return "/conversations/:id"
    case 3 where parts[0] == "titles": return "/titles/:kind/:id"
    default: return "/:unknown"
    }
  }
}
