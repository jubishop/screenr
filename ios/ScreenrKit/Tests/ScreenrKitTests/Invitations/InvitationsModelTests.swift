import Foundation
import Testing

@testable import ScreenrKit

// Creating and revoking invitation links.
@MainActor
struct InvitationsModelTests {
  @Test func createsALinkForTheChosenSignupsAndReadsAgain() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [.response(status: 200, body: try TestFixtures.body("actions/invite/default"))]
    )
    var reads = 0
    let model = InvitationsModel(api: test.client) { reads += 1 }
    #expect(model.limit == 1)

    model.limit = 3
    await model.create()

    #expect(reads == 1)
    #expect(model.failure == nil)
    #expect(
      model.status == "Invitation created. Share its link with the friends you want to invite."
    )
    #expect(try test.transport.requests.first?.json == ["limit": 3])
  }

  @Test func allowsOneToTwelveSignups() throws {
    let test = try TestClient(token: "signed-token", replies: [])
    let model = InvitationsModel(api: test.client) {}

    #expect(InvitationsModel.signupLimits == 1...12)
    model.limit = 12
    #expect(model.canCreate)
    model.limit = 13
    #expect(!model.canCreate)
    model.limit = 0
    #expect(!model.canCreate)
  }

  @Test func revokesALink() async throws {
    let page = try invites()
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .response(status: 200, body: try TestFixtures.body("actions/revoke-invite/default"))
      ]
    )
    var reads = 0
    let model = InvitationsModel(api: test.client) { reads += 1 }
    let invitation = try #require(page.invitations.first)

    await model.revoke(invitation)

    #expect(reads == 1)
    #expect(model.status == "Invitation revoked. Its link no longer works.")
    #expect(model.state == .idle)
    #expect(try test.transport.requests.first?.json == ["id": .string(invitation.id)])
  }

  @Test func saysWhyALinkWasNotChanged() async throws {
    let page = try invites()
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try .json(400, ["error": "Choose between 1 and 12 signups."]),
        try .json(404, ["error": "Invitation not found."]),
      ]
    )
    var reads = 0
    let model = InvitationsModel(api: test.client) { reads += 1 }

    await model.create()
    #expect(model.failure == "Choose between 1 and 12 signups.")
    await model.revoke(try #require(page.invitations.first))

    #expect(model.failure == "Invitation not found.")
    #expect(model.status == nil)
    #expect(reads == 0)
  }

  @Test func describesEachLink() throws {
    let page = try invites()
    let used = try #require(page.invitations.last)

    #expect(used.link?.absoluteString.hasPrefix("http://localhost:3000/join/") == true)
    #expect(used.uses == 1)
    #expect(used.remainingUses == 2)
    #expect(used.joined.map(\.username) == ["hana"])
  }

  private func invites() throws -> InvitesScreen {
    guard case .invites(let page) = try screen("screen/invites/default").content else {
      throw FixtureError("The invites fixture is not an invites screen")
    }
    return page
  }
}
