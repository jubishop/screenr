import Foundation

// The responses of actions other than `screen`, and the error body.

// A response with nothing to read, such as `{"ok": true}` from a write or
// `{"success": true}` from sign-out. Its status already says it succeeded.
public struct Acknowledgement: Decodable, Hashable, Sendable {
  public init() {}

  public init(from decoder: any Decoder) throws {
    _ = try decoder.container(keyedBy: AnyKey.self)
  }

  private struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init(stringValue: String) {
      self.stringValue = stringValue
      intValue = nil
    }

    init(intValue: Int) {
      stringValue = String(intValue)
      self.intValue = intValue
    }
  }
}

// The ID of the entry or comment a write created or changed.
public struct EntryID: Codable, Hashable, Sendable {
  public let id: String
}

// `watch-status`: the progress entry, or nil after clearing the status.
public struct SavedWatchStatus: Codable, Hashable, Sendable {
  public let id: String?
}

// `photo`, `remove-photo`, and `google-photo`: the new photo version, or nil
// after removing it.
public struct PhotoVersion: Codable, Hashable, Sendable {
  public let photo: String?
}

// `invite`: the new invitation. Its link is `/join/<token>`.
public struct CreatedInvitation: Codable, Hashable, Sendable {
  public let id: String
  public let token: String
}

// `/api/auth/invitation`: whether an invitation link can still be used to
// join. An unknown, expired, revoked, or used-up link cannot.
public struct InvitationAvailability: Codable, Hashable, Sendable {
  public let available: Bool
}

// `setup-details`: what first-time setup starts from. `name` is the name the
// sign-in gave the account, such as Google's, or empty. `photo` is a photo
// the account already has, such as a Google signup's copy, and `google` says
// whether Google can supply one.
public struct SetupDetails: Codable, Hashable, Sendable {
  public let userId: String
  public let name: String
  public let photo: String?
  public let google: Bool

  public init(userId: String, name: String, photo: String?, google: Bool) {
    self.userId = userId
    self.name = name
    self.photo = photo
    self.google = google
  }
}

public struct ActivityEmailSetting: Codable, Hashable, Sendable {
  public let activityEmail: Bool
}

// `push-settings`: every push setting after the change.
public struct SavedPushSettings: Codable, Hashable, Sendable {
  public let pushSettings: PushSettings
}

public struct SavedServices: Codable, Hashable, Sendable {
  public let serviceIds: [String]
}

public struct SeasonList: Codable, Hashable, Sendable {
  public let seasons: [Season]
}

public struct EpisodeList: Codable, Hashable, Sendable {
  public let episodes: [Episode]
}

// `read-notification`: the member path the notification opens.
public struct NotificationTarget: Codable, Hashable, Sendable {
  public let href: String
}

// Every Screenr error response. Better Auth's errors carry `message` instead.
// A 426 also names the oldest build the server accepts.
public struct ErrorBody: Codable, Hashable, Sendable {
  public let error: String?
  public let message: String?
  // Better Auth's error code, such as `INVALID_OTP`.
  public let code: String?
  public let minimumBuild: Int?
}
