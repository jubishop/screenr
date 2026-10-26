import Foundation
import Testing

@testable import ScreenrKit

// What a push's alert shows once the notification extension has read its
// notification: the sender, then the action and the comment's excerpt, which
// a spoiler hides. iOS shows a direct message's sender in place of its title
// and subtitle, so the action leads the body.
struct PushContentTests {
  private let entry = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"

  @Test func aCommentShowsItsActionAndExcerpt() throws {
    let content = PushContent(try pushNotification("comment"))

    #expect(
      content.sender == PushSender(id: "user-ben", name: "Ben Ortiz", photo: "8fc275dfeaca5cf8")
    )
    #expect(content.body == "Commented on your post about Harbor Lights: Wait until season 2.")
    #expect(content.conversation == entry)
  }

  @Test func aCommentOnAPostWithoutATitleNamesNoTitle() throws {
    let content = PushContent(try pushNotification("post"))

    #expect(content.body == "Commented on your post: Try Paper Lanterns.")
    #expect(content.conversation == "872a205a-bab2-48f8-8c27-b737397eb469")
  }

  @Test func aReplyShowsItsActionAndExcerpt() throws {
    let content = PushContent(
      try pushNotification(
        "spoiler",
        changes: ["spoiler": false, "excerpt": "Did you see the end?"]
      )
    )

    #expect(content.body == "Replied to your comment about Harbor Lights: Did you see the end?")
    #expect(content.conversation == entry)
  }

  @Test func aSpoilerHidesItsExcerpt() throws {
    let content = PushContent(try pushNotification("spoiler"))

    #expect(content.body == "Replied to your comment about Harbor Lights. Contains spoilers.")
  }

  // The server leaves a spoiler's text out, and the alert would hide it anyway.
  @Test func aSpoilerHidesEvenAnExcerptItArrivesWith() throws {
    let content = PushContent(try pushNotification("spoiler", changes: ["excerpt": "The twist."]))

    #expect(content.body == "Replied to your comment about Harbor Lights. Contains spoilers.")
  }

  @Test func aCommentWithoutAnExcerptShowsOnlyTheAction() throws {
    let content = PushContent(try pushNotification("comment", changes: ["excerpt": .null]))

    #expect(content.body == "Commented on your post about Harbor Lights.")
  }

  @Test func aFriendRequestShowsItsAction() throws {
    let content = PushContent(try pushNotification("friend-request"))

    #expect(content.sender == PushSender(id: "user-fay", name: "Fay Chen", photo: nil))
    #expect(content.body == "Sent you a friend request.")
    // Friendships have no thread, so their alerts group by sender.
    #expect(content.conversation == "user-fay")
  }

  @Test func anAcceptedRequestShowsItsAction() throws {
    let content = PushContent(
      try pushNotification(
        "friend-request",
        changes: ["kind": "friend_accepted", "message": "Fay Chen became your friend."]
      )
    )

    #expect(content.body == "Became your friend.")
    #expect(content.conversation == "user-fay")
  }

  // A kind this build does not know shows the bell's sentence for it.
  @Test func anUnknownKindShowsTheBellsMessage() throws {
    let content = PushContent(
      try pushNotification(
        "comment",
        changes: [
          "kind": "watch_party", "message": "Ben Ortiz invited you to watch Harbor Lights.",
        ]
      )
    )

    #expect(content.body == "Ben Ortiz invited you to watch Harbor Lights.")
    #expect(content.conversation == entry)
  }
}

// A single-notification fixture's notification, with some of its fields changed.
func pushNotification(
  _ fixture: String,
  changes: [String: JSONValue] = [:]
) throws -> PushNotification {
  let body = try JSONDecoder()
    .decode(JSONValue.self, from: try TestFixtures.body("actions/notification/\(fixture)"))
  let notification = try #require(body.member("notification")).merging(changes)
  let lookup = try ScreenrJSON.decoder()
    .decode(
      NotificationLookup.self,
      from: try JSONEncoder().encode(body.merging(["notification": notification]))
    )
  guard case .visible(let visible) = lookup else {
    throw FeedFixtureError(description: "\(fixture) is not a visible notification")
  }
  return visible
}
