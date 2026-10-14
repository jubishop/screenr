import Foundation
import Testing

@testable import ScreenrKit

// Settings' profile editor, activity email switch, and streaming services,
// against the real client and canned replies.
@MainActor
struct SettingsModelTests {
  private static let alice = Person(
    userId: "user-alice",
    username: "alice",
    displayName: "Alice Park",
    photo: nil
  )

  @Test func savesTheNameAndUsernameTogether() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [.response(status: 200, body: try TestFixtures.body("actions/profile/default"))]
    )
    var saved: [Person] = []
    let model = ProfileEditorModel(person: Self.alice, api: test.client) { saved.append($0) }
    #expect(model.name == "Alice Park")
    #expect(model.username == "alice")

    model.username = "alicep"
    await model.save()

    #expect(model.state == .saved)
    #expect(model.failure == nil)
    #expect(saved.map(\.username) == ["alicep"])
    let request = try #require(test.transport.requests.first)
    #expect(request.url?.path() == "/api/screenr/profile")
    #expect(try request.json == ["name": "Alice Park", "username": "alicep"])
  }

  @Test(arguments: [
    ("", "alice"),
    ("   ", "alice"),
    (String(repeating: "a", count: 61), "alice"),
    ("Alice", "al"),
    ("Alice", "alice park"),
    ("Alice", "alice-park"),
    ("Alice", String(repeating: "a", count: 25)),
  ])
  func waitsForValidNames(name: String, username: String) async throws {
    let test = try TestClient(token: "signed-token", replies: [])
    let model = ProfileEditorModel(person: Self.alice, api: test.client) { _ in }

    model.name = name
    model.username = username
    await model.save()

    #expect(!model.canSave)
    #expect(test.transport.requests.isEmpty)
  }

  @Test func acceptsNamesAtTheirLimits() throws {
    let test = try TestClient(token: "signed-token", replies: [])
    let model = ProfileEditorModel(person: Self.alice, api: test.client) { _ in }

    model.name = " " + String(repeating: "é", count: 60) + " "
    model.username = "Al_1"
    #expect(model.canSave)
    model.username = String(repeating: "a", count: 24)
    #expect(model.canSave)
  }

  @Test func keepsEditingWithTheServersReason() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(400, ["error": "That username is already taken."])]
    )
    var saved = 0
    let model = ProfileEditorModel(person: Self.alice, api: test.client) { _ in saved += 1 }

    model.username = "ben"
    await model.save()

    #expect(model.state == .editing)
    #expect(model.failure == "That username is already taken.")
    #expect(saved == 0)
    #expect(model.canSave)
  }

  @Test func savesTheActivityEmailSettingAndReadsAgain() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(200, ["activityEmail": true])]
    )
    var reads = 0
    let model = ActivityEmailModel(api: test.client) { reads += 1 }

    #expect(model.isOn(saved: false) == false)
    await model.set(true)

    #expect(reads == 1)
    #expect(model.saving == nil)
    #expect(model.failure == nil)
    #expect(try test.transport.requests.first?.json == ["enabled": true])
  }

  @Test func showsTheSavedActivityEmailSettingAfterAFailure() async throws {
    let test = try TestClient(token: "signed-token", replies: [.failure(URLError(.timedOut))])
    var reads = 0
    let model = ActivityEmailModel(api: test.client) { reads += 1 }

    await model.set(true)

    #expect(model.isOn(saved: false) == false)
    #expect(model.failure == "Screenr took too long to answer. Try again.")
    #expect(reads == 0)
  }

  @Test func savesTheChosenServicesInListOrder() async throws {
    let page = try account()
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .response(status: 200, body: try TestFixtures.body("actions/streaming-services/default"))
      ]
    )
    var reads = 0
    let model = StreamingServicesModel(
      services: page.services,
      saved: page.serviceIds,
      api: test.client
    ) { reads += 1 }
    #expect(model.selected == ["service:hulu", "service:netflix"])

    model.toggle("service:hulu")
    model.toggle("service:hbo-max")
    await model.save()

    #expect(model.state == .saved)
    #expect(reads == 1)
    #expect(
      try test.transport.requests.first?.json == [
        "serviceIds": ["service:hbo-max", "service:netflix"]
      ]
    )
  }

  @Test func findsServicesByNameAndClearsTheSelection() throws {
    let page = try account()
    let test = try TestClient(token: "signed-token", replies: [])
    let model = StreamingServicesModel(
      services: page.services,
      saved: page.serviceIds,
      api: test.client
    ) {}

    model.query = "  NETFLIX "
    #expect(model.visible.map(\.name).contains("Netflix"))
    #expect(model.visible.allSatisfy { $0.name.localizedCaseInsensitiveContains("netflix") })
    model.query = ""
    #expect(model.visible.count == page.services.count)
    model.clear()
    #expect(model.selected.isEmpty)
  }

  @Test func summarizesTheSavedServices() throws {
    let page = try account()

    #expect(
      StreamingServicesModel.summary(services: page.services, saved: page.serviceIds)
        == "Hulu, Netflix"
    )
    #expect(StreamingServicesModel.summary(services: page.services, saved: []) == "None")
  }

  @Test func readsAppleFromTheAccountScreen() throws {
    let page = try account()

    #expect(page.appleEnabled == true)
    #expect(page.appleConnected == false)
    #expect(page.googleConnected)
  }

  private func account() throws -> AccountScreen {
    guard case .account(let page) = try screen("screen/account/default").content else {
      throw FixtureError("The account fixture is not an account screen")
    }
    return page
  }
}
