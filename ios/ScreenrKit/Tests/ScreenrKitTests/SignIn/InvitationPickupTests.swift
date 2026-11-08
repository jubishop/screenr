import AuthenticationServices
import Foundation
import Testing

@testable import ScreenrKit

// Picking up the invitation an invitation link saved in Safari before the app
// was installed.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct InvitationPickupTests {
  static let token = "8FdwRYhlFy9tcqxOibjISU88FZTgsFeusFjHMbgJ1As"
  static let server = "https://screenr.club"

  static func pickup(members: InMemoryKeychain = InMemoryKeychain()) throws -> InvitationPickup {
    InvitationPickup(
      serverURL: try #require(URL(string: server)),
      browser: .system,
      members: members
    )
  }

  @Test func opensThePickupPageAndKeepsTheInvitationItFinds() async throws {
    let pickup = try Self.pickup()
    let storage = InMemoryKeychain()
    let invitation = PendingInvitation(storage: storage)
    let safari = PickupAuthenticator(.token(Self.token))
    #expect(pickup.phase == .due)

    await pickup.pickUp(into: invitation, using: safari)

    #expect(safari.opened.map(\.url.absoluteString) == ["\(Self.server)/api/invitation-pickup"])
    #expect(
      safari.opened.map(\.callback) == [
        .https(host: "screenr.club", path: "/api/invitation-pickup/done")
      ]
    )
    // As if the person had followed the link: kept, then checked.
    #expect(invitation.token == Self.token)
    #expect(invitation.status == .checking)
    #expect(try storage.read() == Self.token)
    #expect(pickup.phase == .done)
  }

  @Test func missesWhenSafariHasNoInvitationOrThePersonDeclines() async throws {
    let answers: [PickupAuthenticator.Answer] = [
      .callback("\(Self.server)/api/invitation-pickup/done"),
      .error(ASWebAuthenticationSessionError(.canceledLogin)),
      .error(ASWebAuthenticationSessionError(.presentationContextInvalid)),
      // Only the pickup's own callback carries an invitation.
      .callback("https://example.com/api/invitation-pickup/done?token=\(Self.token)"),
      .callback("\(Self.server)/join/done?token=\(Self.token)"),
      .callback("\(Self.server)/api/invitation-pickup/done?token=too-short"),
      .callback(
        "\(Self.server)/api/invitation-pickup/done?token=\(String(repeating: "a", count: 42))!"
      ),
    ]
    for answer in answers {
      let pickup = try Self.pickup()
      let invitation = PendingInvitation(storage: InMemoryKeychain())

      await pickup.pickUp(into: invitation, using: PickupAuthenticator(answer))

      #expect(pickup.phase == .missed, "\(answer)")
      #expect(invitation.token == nil, "\(answer)")
      #expect(invitation.status == .none, "\(answer)")
    }
  }

  @Test func asksOnceALaunchAndNotWhileAnInvitationWaits() async throws {
    let pickup = try Self.pickup()
    let safari = PickupAuthenticator(.callback("\(Self.server)/api/invitation-pickup/done"))
    let waiting = PendingInvitation(token: "opened-link")

    await pickup.pickUp(into: waiting, using: safari)
    #expect(safari.opened.isEmpty)
    #expect(pickup.phase == .due)

    let invitation = PendingInvitation(storage: InMemoryKeychain())
    await pickup.pickUp(into: invitation, using: safari)
    await pickup.pickUp(into: invitation, using: safari)
    #expect(safari.opened.count == 1)
    #expect(pickup.phase == .missed)
  }

  @Test func neverAsksWhereAMemberHasSignedIn() async throws {
    let members = InMemoryKeychain()
    let pickup = try Self.pickup(members: members)

    pickup.memberSignedIn()

    #expect(pickup.phase == .done)
    #expect(try members.read() == InvitationPickup.memberMark)
    // The mark outlives the app, so a later install never asks either.
    let later = try Self.pickup(members: members)
    let safari = PickupAuthenticator(.token(Self.token))
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    #expect(later.phase == .done)
    await later.pickUp(into: invitation, using: safari)
    #expect(safari.opened.isEmpty)
    #expect(invitation.token == nil)
  }

  @Test func aLinkThatOpensWhileSafariAnswersTakesItsPlace() async throws {
    let pickup = try Self.pickup()
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    let safari = PickupAuthenticator(.token(Self.token)) { invitation.open("tapped-link") }

    await pickup.pickUp(into: invitation, using: safari)

    #expect(invitation.token == "tapped-link")
    #expect(pickup.phase == .done)
  }

  @Test func theFixtureAPIStandsInForSafari() async throws {
    let outcomes: [(FixtureScenario.Pickup, String?)] = [
      (.found, FixtureInvitationPickup.token),
      (.missing, nil),
      (.declined, nil),
    ]
    for (outcome, token) in outcomes {
      let pickup = InvitationPickup(
        serverURL: try #require(URL(string: Self.server)),
        browser: .fixture(FixtureInvitationPickup(outcome: outcome)),
        members: InMemoryKeychain()
      )
      let invitation = PendingInvitation(storage: InMemoryKeychain())
      let safari = PickupAuthenticator(.token(Self.token))

      await pickup.pickUp(into: invitation, using: safari)

      #expect(safari.opened.isEmpty, "\(outcome)")
      #expect(invitation.token == token, "\(outcome)")
      #expect(pickup.phase == (token == nil ? .missed : .done), "\(outcome)")
    }
  }

  @Test func readsTheFixturePickupFromTheLaunchArguments() throws {
    for outcome in ["found", "missing", "declined"] {
      let source = try APISource(
        arguments: ["Screenr", "-ScreenrFixtures", "/fixtures", "-ScreenrFixturePickup", outcome],
        variant: .dev
      )
      guard case .fixtures(_, let scenario) = source else {
        Issue.record("Expected the fixture API")
        return
      }
      #expect(scenario.pickup?.rawValue == outcome)
    }
    #expect(throws: APISource.ArgumentError.self) {
      try APISource(arguments: ["Screenr", "-ScreenrFixturePickup", "maybe"], variant: .dev)
    }
  }
}

// Answers the pickup page as Safari would, and records what it opened.
@MainActor
final class PickupAuthenticator: WebAuthenticator {
  enum Answer: CustomStringConvertible {
    case token(String)
    case callback(String)
    case error(any Error)

    var description: String {
      switch self {
      case .token(let token): "token \(token)"
      case .callback(let url): url
      case .error(let error): "\(error)"
      }
    }
  }

  struct Opened {
    let url: URL
    let callback: WebCallback
  }

  private let answer: Answer
  private let whileAnswering: @MainActor () -> Void
  private(set) var opened: [Opened] = []

  init(_ answer: Answer, whileAnswering: @escaping @MainActor () -> Void = {}) {
    self.answer = answer
    self.whileAnswering = whileAnswering
  }

  func authenticate(url: URL, callback: WebCallback) async throws -> URL {
    opened.append(Opened(url: url, callback: callback))
    whileAnswering()
    let text: String
    switch answer {
    case .token(let token):
      text = "https://screenr.club/api/invitation-pickup/done?token=\(token)"
    case .callback(let url):
      text = url
    case .error(let error):
      throw error
    }
    guard let redirect = URL(string: text) else { throw URLError(.badURL) }
    return redirect
  }
}
