import AuthenticationServices
import Foundation
import Observation

// Picks up the invitation an invitation link saved in Safari. On an iPhone
// without Screenr, the link keeps the invitation in a Safari cookie and goes
// to install the app, and an install carries no link into it. So before a
// person without an invitation first signs in, the app opens the server's
// pickup page in a web authentication session, which shares Safari's
// cookies. iOS asks whether Screenr may use the site to sign in, and the page
// redirects to an https callback with the invitation, which iOS hands only to
// an app the site names. The invitation becomes the pending invitation, as if
// the person had followed the link.
//
// The app asks once a launch, and never on an iPhone where a member has
// signed in, which a Keychain item that outlives the app records.
@MainActor
@Observable
public final class InvitationPickup {
  public enum Phase: Hashable, Sendable {
    // The next sign-in without an invitation asks Safari first.
    case due
    // Asking Safari.
    case asking
    // Safari had no invitation, or the person declined to share it, so the
    // sign-in screen asks them to tap their invitation link again.
    case missed
    // A member has signed in on this iPhone, or an invitation came through.
    case done
  }

  // The web authentication session that opens the pickup page: the one the
  // sign-in screen passes, or in Screenr Dev, the fixture API's stand-in.
  public enum Browser: Sendable {
    case system
    case fixture(any WebAuthenticator)
  }

  static let path = "/api/invitation-pickup"
  static let callbackPath = "/api/invitation-pickup/done"
  static let memberMark = "signed-in"

  public private(set) var phase: Phase
  @ObservationIgnored private let serverURL: URL
  @ObservationIgnored private let browser: Browser
  @ObservationIgnored private let members: any KeychainStorage
  @ObservationIgnored private var memberRecorded: Bool

  // `members` keeps the mark that a member signed in on this iPhone.
  public init(serverURL: URL, browser: Browser, members: any KeychainStorage) {
    self.serverURL = serverURL
    self.browser = browser
    self.members = members
    var marked = false
    do {
      marked = try members.read() != nil
    } catch {
      Log.session.error("Could not read the member mark", .int("status", Int(error.status)))
    }
    memberRecorded = marked
    phase = marked ? .done : .due
  }

  // Records that a member signed in on this iPhone, so the app never asks
  // Safari for an invitation here again.
  public func memberSignedIn() {
    phase = .done
    guard !memberRecorded else { return }
    do {
      try members.write(Self.memberMark)
      memberRecorded = true
    } catch {
      Log.session.error("Could not record the member mark", .int("status", Int(error.status)))
    }
  }

  // Asks Safari for the invitation it saved, through `system` unless the
  // fixture API stands in, and keeps it in `invitation`. It asks only while
  // the pickup is due and `invitation` has no token.
  public func pickUp(into invitation: PendingInvitation, using system: any WebAuthenticator) async {
    guard phase == .due, invitation.token == nil else { return }
    phase = .asking
    let authenticator: any WebAuthenticator =
      switch browser {
      case .system: system
      case .fixture(let fixture): fixture
      }
    let token = await ask(using: authenticator)
    // A link that opened while Safari answered takes its place.
    if let token, invitation.token == nil {
      Log.session.info("Picked up an invitation from Safari")
      invitation.open(token)
    }
    phase = invitation.token == nil ? .missed : .done
  }

  private func ask(using authenticator: any WebAuthenticator) async -> String? {
    guard let host = serverURL.host() else { return nil }
    let callback: URL
    do {
      callback = try await authenticator.authenticate(
        url: serverURL.appending(path: Self.path),
        callback: .https(host: host, path: Self.callbackPath)
      )
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      Log.session.info("The person declined to pick up an invitation")
      return nil
    } catch {
      Log.session.warning("Could not pick up an invitation", .error(error))
      return nil
    }
    let token = Self.token(in: callback, host: host)
    if token == nil { Log.session.info("Safari had no invitation to pick up") }
    return token
  }

  // The invitation token in the pickup's callback, which names none when
  // Safari saved none.
  static func token(in callback: URL, host: String) -> String? {
    guard callback.scheme == "https", callback.host() == host, callback.path() == callbackPath,
      let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
    else { return nil }
    guard let token = items.first(where: { $0.name == "token" })?.value, isToken(token) else {
      return nil
    }
    return token
  }

  // Every invitation token is 32 random bytes in unpadded base64url.
  private static func isToken(_ text: String) -> Bool {
    text.count == 43
      && text.unicodeScalars.allSatisfy { scalar in
        scalar.isASCII
          && (CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_")
      }
  }
}
