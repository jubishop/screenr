import Foundation
import Testing

@testable import ScreenrKit

// First-time setup's model, against the real client and canned replies.
@MainActor
struct SetupModelTests {
  @MainActor
  private final class Joins {
    var count = 0
  }

  private func model(
    _ test: TestClient,
    invitation: PendingInvitation = PendingInvitation(),
    joins: Joins = Joins()
  ) -> SetupModel {
    SetupModel(api: test.client, invitation: invitation) { joins.count += 1 }
  }

  private static func fixture(_ name: String) throws -> RecordingTransport.Reply {
    .response(status: 200, body: try TestFixtures.body(name))
  }

  @Test func startsFromTheSignInsNameAndTheAccountsPhoto() async throws {
    let test = try TestClient(
      token: "session",
      replies: [try Self.fixture("actions/setup-details/google")]
    )
    let model = model(test)

    await model.load()

    #expect(model.name == "Pat Morgan")
    #expect(model.username == "")
    #expect(model.photo.userId == "user-pat")
    #expect(model.photo.version == "4136d3dfc694c315")
    #expect(model.photo.google)
    #expect(test.transport.requests.first?.url?.path() == "/api/screenr/setup-details")
  }

  @Test func keepsANameTheMemberAlreadyTyped() async throws {
    let test = try TestClient(
      token: "session",
      replies: [try Self.fixture("actions/setup-details/default")]
    )
    let model = model(test)
    model.name = "Patrick"

    await model.load()

    #expect(model.name == "Patrick")
  }

  @Test func startsEmptyWhenTheDetailsCannotLoad() async throws {
    let test = try TestClient(
      token: "session",
      replies: [.failure(URLError(.notConnectedToInternet))]
    )
    let model = model(test)

    await model.load()

    #expect(model.name == "")
    #expect(model.photo.userId == nil)
    #expect(model.failure == nil)
  }

  @Test func joinsWithTheInvitationAndUsesItUp() async throws {
    let test = try TestClient(token: "session", replies: [try .json(200, ["ok": true])])
    let invitation = PendingInvitation(token: "invite-1")
    let joins = Joins()
    let model = model(test, invitation: invitation, joins: joins)
    model.name = "Pat Morgan"
    model.username = "pat"

    await model.join()

    let request = try #require(test.transport.requests.first)
    #expect(request.url?.path() == "/api/screenr/setup")
    #expect(try request.json == ["name": "Pat Morgan", "username": "pat"])
    #expect(test.header("Screenr-Invitation") == "invite-1")
    #expect(invitation.token == nil)
    #expect(invitation.status == .none)
    #expect(joins.count == 1)
    #expect(model.failure == nil)
    #expect(model.activity == .idle)
  }

  @Test func waitsForANameAndAUsername() async throws {
    let test = try TestClient(token: "session", replies: [])
    let model = model(test)

    for (name, username) in [("", ""), ("Pat", ""), ("", "pat"), (" ", "pat"), ("Pat", "  ")] {
      model.name = name
      model.username = username
      #expect(!model.canJoin, "\(name), \(username)")
      await model.join()
    }
    model.name = "Pat"
    model.username = "pat"

    #expect(model.canJoin)
    #expect(test.transport.requests.isEmpty)
  }

  @Test func showsTheServersWordsForAnInvalidProfile() async throws {
    let test = try TestClient(
      token: "session",
      replies: [try .json(400, ["error": "That username is already taken."])]
    )
    let invitation = PendingInvitation(token: "invite-1")
    let joins = Joins()
    let model = model(test, invitation: invitation, joins: joins)
    model.name = "Pat Morgan"
    model.username = "alice"

    await model.join()

    #expect(model.failure == "That username is already taken.")
    #expect(model.username == "alice")
    #expect(invitation.token == "invite-1")
    #expect(joins.count == 0)
  }

  @Test func forgetsAnInvitationTheServerNoLongerAccepts() async throws {
    let refusal = "This invitation is no longer available. Ask for a new link."
    let test = try TestClient(
      token: "session",
      replies: [try .json(403, ["error": .string(refusal)]), try .json(200, ["available": false])]
    )
    let invitation = PendingInvitation(token: "invite-1")
    let model = model(test, invitation: invitation)
    model.name = "Pat Morgan"
    model.username = "pat"

    await model.join()

    #expect(model.failure == refusal)
    #expect(invitation.status == .unavailable)
    #expect(invitation.token == nil)
    #expect(test.transport.requests.last?.url?.path() == "/api/auth/invitation")
  }
}
