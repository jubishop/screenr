import Foundation

// Whether this launch is the first since Screenr was installed, or installed
// again after the member deleted it. Deleting the app removes its own
// UserDefaults and its app group, where it logs, but iOS keeps its Keychain
// items, so the first launch after a reinstall would otherwise restore the
// last member's session without a sign-in.
public enum InstallLaunch: Hashable, Sendable {
  case first
  case later

  // The app's own UserDefaults key that marks this install as launched.
  static let launchedKey = "launchedSinceInstall"

  // Reads and marks this install's launch. An install without the mark is new
  // unless the app's log, which every earlier build wrote at each launch,
  // already exists, as after an update from a build before the mark.
  // Only the app's own log counts, since an extension may run before the
  // app's first launch. Call it before this launch logs to `appLog`.
  public static func record(defaults: UserDefaults, appLog: LogFile?) -> InstallLaunch {
    guard !defaults.bool(forKey: launchedKey) else { return .later }
    defaults.set(true, forKey: launchedKey)
    let files = FileManager.default
    let logged = [appLog?.currentURL, appLog?.previousURL]
      .contains { url in
        guard let url else { return false }
        return files.fileExists(atPath: url.path())
      }
    return logged ? .later : .first
  }

  // At the first launch, ends the session that the last install left in
  // the Keychain. Its token goes at once, so the app starts signed out, and
  // the returned task signs the session out on the server, so it stops
  // receiving pushes. If the server cannot be reached, the session ends when
  // it expires. Later launches, and first launches without a token, do
  // nothing.
  @MainActor
  func endEarlierSession(
    keychain: any KeychainStorage,
    serverURL: URL,
    clientHeader: String,
    transport: any HTTPTransport
  ) throws(KeychainError) -> Task<Void, Never>? {
    guard self == .first, let token = try keychain.read() else { return nil }
    try keychain.delete()
    Log.session.info("Signing out the session a deleted install left")
    let earlier = try SessionStore(keychain: InMemoryKeychain(token: token))
    let client = ScreenrClient(
      serverURL: serverURL,
      clientHeader: clientHeader,
      session: earlier,
      transport: transport
    )
    return Task {
      do throws(APIError) {
        _ = try await client.send(.signOut)
      } catch  where error.kind == .signedOut {
        Log.session.info("The session a deleted install left had already ended")
      } catch {
        Log.session.warning(
          "Could not sign out the session a deleted install left",
          .error(error),
          .identifier("request_id", error.requestID)
        )
      }
    }
  }
}
