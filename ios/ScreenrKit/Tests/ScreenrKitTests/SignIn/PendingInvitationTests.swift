import Foundation
import Testing

@testable import ScreenrKit

// The invitation link a new member opened, which the app keeps and checks
// until setup succeeds.
@MainActor
struct PendingInvitationTests {
  private static let token = "8FdwRYhlFy9tcqxOibjISU88FZTgsFeusFjHMbgJ1As"

  private static func availability(_ available: Bool) throws -> RecordingTransport.Reply {
    try .json(200, ["available": .bool(available)])
  }

  @Test func keepsAnOpenedLinkAcrossLaunches() throws {
    let storage = InMemoryKeychain()
    let invitation = PendingInvitation(storage: storage)
    #expect(invitation.token == nil)
    #expect(invitation.status == .none)

    invitation.open(Self.token)

    #expect(invitation.token == Self.token)
    #expect(invitation.status == .checking)
    #expect(try storage.read() == Self.token)
    // The next launch checks the kept link again.
    let relaunched = PendingInvitation(storage: storage)
    #expect(relaunched.token == Self.token)
    #expect(relaunched.status == .checking)
  }

  @Test func asksTheServerWhetherTheLinkCanBeUsed() async throws {
    let test = try TestClient(replies: [try Self.availability(true)])
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    invitation.open(Self.token)

    await invitation.check(using: test.client)

    #expect(invitation.status == .available)
    #expect(invitation.token == Self.token)
    let request = try #require(test.transport.requests.first)
    #expect(request.httpMethod == "GET")
    #expect(request.url?.path() == "/api/auth/invitation")
    #expect(request.url?.query() == "token=\(Self.token)")
    // Asking is not joining, so the request does not name the invitation.
    #expect(test.header("Screenr-Invitation") == nil)
    // The route that logs and error reports name leaves out the token.
    #expect(test.observer.records.map(\.route) == ["/api/auth/invitation"])
  }

  @Test func forgetsALinkThatCannotBeUsed() async throws {
    let test = try TestClient(replies: [try Self.availability(false)])
    let storage = InMemoryKeychain()
    let invitation = PendingInvitation(storage: storage)
    invitation.open(Self.token)

    await invitation.check(using: test.client)

    #expect(invitation.status == .unavailable)
    #expect(invitation.token == nil)
    #expect(try storage.read() == nil)
  }

  @Test func keepsTheLinkWhenTheCheckFails() async throws {
    let test = try TestClient(replies: [.failure(URLError(.notConnectedToInternet))])
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    invitation.open(Self.token)

    await invitation.check(using: test.client)

    // Sign-in still sends the token, and the server decides.
    #expect(invitation.status == .unconfirmed)
    #expect(invitation.token == Self.token)
  }

  @Test func checksOnlyALinkWaitingForACheck() async throws {
    let test = try TestClient(replies: [try Self.availability(true)])
    let invitation = PendingInvitation(storage: InMemoryKeychain())

    await invitation.check(using: test.client)
    invitation.open(Self.token)
    await invitation.check(using: test.client)
    await invitation.check(using: test.client)

    #expect(test.transport.requests.count == 1)
    #expect(invitation.status == .available)
  }

  @Test func checksAgainWhenTheServerRefusesIt() async throws {
    let test = try TestClient(replies: [try Self.availability(true), try Self.availability(false)])
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    invitation.open(Self.token)
    await invitation.check(using: test.client)

    await invitation.recheck(using: test.client)

    #expect(invitation.status == .unavailable)
    #expect(invitation.token == nil)
    #expect(test.transport.requests.count == 2)
  }

  @Test func forgetsTheLinkOnceItIsUsed() throws {
    let storage = InMemoryKeychain()
    let invitation = PendingInvitation(storage: storage)
    invitation.open(Self.token)

    invitation.finish()

    #expect(invitation.token == nil)
    #expect(invitation.status == .none)
    #expect(try storage.read() == nil)
    #expect(PendingInvitation(storage: storage).token == nil)
  }

  @Test func aNewLinkReplacesAnUnavailableOne() async throws {
    let test = try TestClient(replies: [try Self.availability(false), try Self.availability(true)])
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    invitation.open("unavailable-link")
    await invitation.check(using: test.client)

    invitation.open(Self.token)
    await invitation.check(using: test.client)

    #expect(invitation.status == .available)
    #expect(invitation.token == Self.token)
  }
}
