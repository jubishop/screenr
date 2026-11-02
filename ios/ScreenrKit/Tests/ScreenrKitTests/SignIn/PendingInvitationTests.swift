import Foundation
import Testing

@testable import ScreenrKit

// The invitation link a new member opened, which the app keeps and checks
// until setup succeeds.
@MainActor
@Suite(.timeLimit(.minutes(1)))
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

  // A check cut short, such as when its view goes away, leaves the link
  // waiting for the next check.
  @Test func aCancelledCheckLeavesTheLinkWaitingForTheNext() async throws {
    let test = try TestClient(
      replies: [.failure(URLError(.cancelled)), try Self.availability(true)]
    )
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    invitation.open(Self.token)

    await invitation.check(using: test.client)
    #expect(invitation.status == .checking)
    await invitation.check(using: test.client)

    #expect(invitation.status == .available)
    #expect(test.transport.requests.count == 2)
  }

  // The server's answer about a link that another link replaced meanwhile
  // leaves the new link waiting for its own check.
  @Test func anAnswerForAReplacedLinkLeavesTheNewLink() async throws {
    let api = GatedAPI(RecordingAPI(["invitation": .success(["available": false])]))
    let storage = InMemoryKeychain()
    let invitation = PendingInvitation(storage: storage)
    invitation.open("earlier-link")
    let checking = Task { await invitation.check(using: api) }
    await api.waitForRequests(1)

    invitation.open(Self.token)
    api.open()
    await finish(checking)

    #expect(invitation.token == Self.token)
    #expect(invitation.status == .checking)
    #expect(try storage.read() == Self.token)
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
