import Foundation
import Testing

@testable import ScreenrKit

// Deleting the app removes its own UserDefaults and its app group, where it
// logs, but iOS keeps the Keychain. So the first launch after a reinstall
// finds no mark in UserDefaults and no earlier log, and signs out the session
// the last install left.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct InstallLaunchTests {
  private let suite = "ScreenrKitTests-\(UUID().uuidString)"
  private let directory = TemporaryDirectory()

  private func defaults() throws -> UserDefaults {
    try #require(UserDefaults(suiteName: suite))
  }

  private func cleanUp() {
    UserDefaults.standard.removePersistentDomain(forName: suite)
    directory.remove()
  }

  @Test func aNewInstallsFirstLaunchIsItsOnlyFirst() throws {
    defer { cleanUp() }
    let log = LogFile(directory: directory.url, name: "app")

    #expect(InstallLaunch.record(defaults: try defaults(), appLog: log) == .first)
    #expect(InstallLaunch.record(defaults: try defaults(), appLog: log) == .later)
  }

  // A build from before the mark logged every launch to the app group, so an
  // update keeps its member signed in.
  @Test func anUpdateFromABuildWithoutTheMarkIsNotAFirstLaunch() async throws {
    defer { cleanUp() }
    let earlier = LogFile(directory: directory.url, name: "app")
    Log(.app, router: LogRouter(sinks: [earlier])).info("Launched")
    await earlier.flush()

    let log = LogFile(directory: directory.url, name: "app")
    #expect(InstallLaunch.record(defaults: try defaults(), appLog: log) == .later)
  }

  // Only the app's own log counts: an extension may run before the app's
  // first launch after a reinstall.
  @Test func anExtensionsLogIsNotAnEarlierLaunch() async throws {
    defer { cleanUp() }
    let share = LogFile(directory: directory.url, name: "share")
    Log(LogCategory("share"), router: LogRouter(sinks: [share])).info("Share opened a title")
    await share.flush()

    let log = LogFile(directory: directory.url, name: "app")
    #expect(InstallLaunch.record(defaults: try defaults(), appLog: log) == .first)
  }

  // The token goes at once, so the launch starts signed out, and the server
  // ends its session, which stops pushes to its devices.
  @Test func aFirstLaunchSignsOutTheSessionTheLastInstallLeft() async throws {
    let keychain = InMemoryKeychain(token: "earlier-token")
    let transport = RecordingTransport([try .json(200, ["success": true])])

    let signOut = try InstallLaunch.first.endEarlierSession(
      keychain: keychain,
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      transport: transport
    )

    #expect(try keychain.read() == nil)
    #expect(try SessionStore(keychain: keychain).phase == .signedOut)
    await signOut?.value
    let request = try #require(transport.requests.first)
    #expect(transport.requests.count == 1)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "http://localhost:3000/api/auth/sign-out")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer earlier-token")
  }

  // Signed out on the phone, the member stays so when the server cannot be
  // reached; the session then ends when it expires.
  @Test func aFirstLaunchStaysSignedOutWhenTheServerCannotBeReached() async throws {
    let keychain = InMemoryKeychain(token: "earlier-token")
    let transport = RecordingTransport([.failure(URLError(.notConnectedToInternet))])

    let signOut = try InstallLaunch.first.endEarlierSession(
      keychain: keychain,
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      transport: transport
    )
    await signOut?.value

    #expect(try keychain.read() == nil)
    #expect(transport.requests.count == 1)
  }

  @Test func laterLaunchesAndFirstLaunchesWithoutASessionSendNothing() throws {
    let transport = RecordingTransport([])
    let serverURL = try #require(URL(string: "http://localhost:3000"))
    let signedIn = InMemoryKeychain(token: "current-token")

    let later = try InstallLaunch.later.endEarlierSession(
      keychain: signedIn,
      serverURL: serverURL,
      clientHeader: "ios/1.0/7",
      transport: transport
    )
    let signedOut = try InstallLaunch.first.endEarlierSession(
      keychain: InMemoryKeychain(),
      serverURL: serverURL,
      clientHeader: "ios/1.0/7",
      transport: transport
    )

    #expect(later == nil)
    #expect(signedOut == nil)
    #expect(try signedIn.read() == "current-token")
    #expect(transport.requests.isEmpty)
  }
}
