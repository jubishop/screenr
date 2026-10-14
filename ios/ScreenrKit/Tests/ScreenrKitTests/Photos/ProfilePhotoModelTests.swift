import CoreGraphics
import Foundation
import Testing
import UniformTypeIdentifiers

@testable import ScreenrKit

// The member's own photo, during setup and in Settings, against the real
// client and canned replies.
@MainActor
struct ProfilePhotoModelTests {
  private static func libraryPhoto() throws -> Data {
    try PhotoPreparationTests.encode(
      PhotoPreparationTests.image(width: 800, height: 600) { _, _ in .blue },
      as: .png
    )
  }

  @Test func addsAPhotoFromTheLibrary() async throws {
    let test = try TestClient(token: "session", replies: [try .json(200, ["photo": "v1"])])
    let model = ProfilePhotoModel(api: test.client)

    await model.upload(try Self.libraryPhoto())

    #expect(model.version == "v1")
    #expect(model.status == "Photo added.")
    #expect(model.failure == nil)
    #expect(model.activity == .idle)
    let request = try #require(test.transport.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path() == "/api/screenr/photo")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "image/jpeg")
    let sent = try #require(request.httpBody)
    #expect(sent.count <= PhotoPreparation.limit)
    let prepared = try PhotoPreparationTests.decode(sent)
    #expect(prepared.type == UTType.jpeg.identifier)
    #expect(prepared.image.width == 512 && prepared.image.height == 512)
    // The saved JPEG shows at once, without a download.
    #expect(model.jpeg == sent)
  }

  @Test func replacesAPhoto() async throws {
    let test = try TestClient(token: "session", replies: [try .json(200, ["photo": "v2"])])
    let model = ProfilePhotoModel(api: test.client)
    model.show(userId: "user-pat", version: "v1", google: false)

    await model.upload(try Self.libraryPhoto())

    #expect(model.version == "v2")
    #expect(model.status == "Photo replaced.")
  }

  @Test func reportsAPhotoItCannotOpen() async throws {
    let test = try TestClient(token: "session", replies: [])
    let model = ProfilePhotoModel(api: test.client)

    await model.upload(Data("not a photo".utf8))

    #expect(model.failure == "This photo could not be opened. Choose another photo.")
    #expect(model.status == nil)
    #expect(model.version == nil)
    #expect(test.transport.requests.isEmpty)
  }

  @Test func savesAPhotoOnceTheLibraryHandsItOver() async throws {
    let test = try TestClient(token: "session", replies: [try .json(200, ["photo": "v1"])])
    let model = ProfilePhotoModel(api: test.client)
    let photo = try Self.libraryPhoto()

    await model.upload { photo }

    #expect(model.version == "v1")
    #expect(model.status == "Photo added.")
  }

  @Test func reportsAPhotoTheLibraryCannotHandOver() async throws {
    let test = try TestClient(token: "session", replies: [])
    let model = ProfilePhotoModel(api: test.client)

    await model.upload { throw URLError(.cannotOpenFile) }
    let unreadable = model.failure
    await model.upload { nil }

    #expect(unreadable == "This photo could not be opened. Choose another photo.")
    #expect(model.failure == "This photo could not be opened. Choose another photo.")
    #expect(test.transport.requests.isEmpty)
  }

  @Test func showsTheServersRefusal() async throws {
    let test = try TestClient(
      token: "session",
      replies: [try .json(413, ["error": "Photos must be 200 KB or smaller."])]
    )
    let model = ProfilePhotoModel(api: test.client)
    model.show(userId: "user-pat", version: "v1", google: false)

    await model.upload(try Self.libraryPhoto())

    #expect(model.failure == "Photos must be 200 KB or smaller.")
    #expect(model.version == "v1")
    #expect(model.jpeg == nil)
  }

  @Test func usesTheGooglePhoto() async throws {
    let test = try TestClient(token: "session", replies: [try .json(200, ["photo": "g1"])])
    let model = ProfilePhotoModel(api: test.client)
    model.show(userId: "user-pat", version: nil, google: true)

    await model.useGoogle()

    #expect(model.version == "g1")
    #expect(model.status == "Google photo added.")
    #expect(test.transport.requests.first?.url?.path() == "/api/screenr/google-photo")
  }

  @Test func removesThePhoto() async throws {
    let test = try TestClient(token: "session", replies: [try .json(200, ["photo": .null])])
    let model = ProfilePhotoModel(api: test.client)
    model.show(userId: "user-pat", version: "v1", google: false)

    await model.remove()

    #expect(model.version == nil)
    #expect(model.jpeg == nil)
    #expect(model.status == "Photo removed.")
    #expect(test.transport.requests.first?.url?.path() == "/api/screenr/remove-photo")
  }

  // Photos are shown only to signed-in people who may see them, so the
  // download carries the session like any API request.
  @Test func downloadsTheCurrentPhoto() async throws {
    let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])
    let test = try TestClient(
      token: "session",
      replies: [.response(status: 200, headers: ["Content-Type": "image/jpeg"], body: bytes)]
    )
    let model = ProfilePhotoModel(api: test.client)
    model.show(userId: "user-pat", version: "v1", google: false)

    await model.loadPhoto()
    await model.loadPhoto()

    #expect(model.jpeg == bytes)
    #expect(test.transport.requests.count == 1)
    let request = try #require(test.transport.requests.first)
    #expect(request.url?.path() == "/api/photos/user-pat/v1")
    #expect(test.header("Authorization") == "Bearer session")
    #expect(test.observer.records.map(\.route) == ["/api/photos/:user/:version"])
  }

  @Test func keepsTheInitialWhenThePhotoCannotLoad() async throws {
    let test = try TestClient(token: "session", replies: [try .json(404, ["error": "Not found."])])
    let model = ProfilePhotoModel(api: test.client)
    model.show(userId: "user-pat", version: "v1", google: false)

    await model.loadPhoto()

    #expect(model.jpeg == nil)
    #expect(model.failure == nil)
  }
}
