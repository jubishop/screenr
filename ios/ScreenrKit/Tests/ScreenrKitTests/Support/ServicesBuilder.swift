import Foundation
import Testing

@testable import ScreenrKit

// Builds an extension's services on one Keychain, as each push or share
// would read it, and keeps each one's transport. The first services answer
// with `replies`; later ones answer nothing.
@MainActor
final class ServicesBuilder {
  let keychain = InMemoryKeychain(token: "signed-token")
  private var replies: [RecordingTransport.Reply]
  private(set) var transports: [RecordingTransport] = []

  init(replies: [RecordingTransport.Reply] = []) {
    self.replies = replies
  }

  func services(arguments: [String]) throws -> AppServices {
    let transport = RecordingTransport(transports.isEmpty ? replies : [])
    transports.append(transport)
    let session = try SessionStore(keychain: keychain)
    return AppServices(
      api: ScreenrClient(
        serverURL: try #require(URL(string: "http://localhost:3000")),
        clientHeader: "ios/1.0/7",
        session: session,
        transport: transport,
        notifications: NotificationCenter()
      ),
      session: session,
      identity: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(clientID: GoogleSignInTests.clientID, transport: transport)
      )
    )
  }
}
