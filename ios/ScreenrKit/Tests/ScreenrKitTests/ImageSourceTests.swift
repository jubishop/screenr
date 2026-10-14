import Foundation
import Testing

@testable import ScreenrKit

// Posters come from TMDB, as the web shows them, and profile photos from the
// server with the session's bearer token.
@MainActor
struct ImageSourceTests {
  private func source(token: String?) throws -> ImageSource {
    let session = try SessionStore(keychain: InMemoryKeychain(token: token))
    return ImageSource(
      serverURL: try #require(URL(string: "https://screenr.club")),
      clientHeader: "ios/1.0/7",
      session: session
    )
  }

  @Test func loadsPostersFromTMDB() throws {
    let source = try source(token: nil)
    #expect(
      source.poster("/harbor-lights.jpg")?.url?.absoluteString
        == "https://image.tmdb.org/t/p/w342/harbor-lights.jpg"
    )
    #expect(source.poster(nil) == nil)
    #expect(source.poster("") == nil)
  }

  @Test func loadsServiceLogosFromTMDB() throws {
    let source = try source(token: nil)
    #expect(
      source.logo("/netflix.png")?.url?.absoluteString
        == "https://image.tmdb.org/t/p/w92/netflix.png"
    )
    #expect(source.logo(nil) == nil)
    #expect(ImageSource.none.logo("/netflix.png") == nil)
  }

  @Test func loadsPhotosWithTheBearerToken() throws {
    let request = try #require(
      try source(token: "token-1").photo(userId: "user/ben", version: "8fc2")
    )

    #expect(request.url?.absoluteString == "https://screenr.club/api/photos/user%2Fben/8fc2")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-1")
    #expect(request.value(forHTTPHeaderField: "Screenr-Client") == "ios/1.0/7")
    #expect(request.httpShouldHandleCookies == false)
  }

  @Test func showsInitialsWithoutAPhotoOrSession() throws {
    #expect(try source(token: "token-1").photo(userId: "user-ben", version: nil) == nil)
    #expect(try source(token: nil).photo(userId: "user-ben", version: "8fc2") == nil)
    #expect(ImageSource.none.photo(userId: "user-ben", version: "8fc2") == nil)
    #expect(ImageSource.none.poster("/harbor-lights.jpg") == nil)
  }
}
