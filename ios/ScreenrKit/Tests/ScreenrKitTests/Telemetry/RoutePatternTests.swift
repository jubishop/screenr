import Foundation
import Testing

@testable import ScreenrKit

struct RoutePatternTests {
  @Test(arguments: [
    ("/", "/"),
    ("", "/"),
    ("/search?q=dune&tab=friends-recommend", "/search"),
    ("/people", "/people"),
    ("/invites", "/invites"),
    ("/account", "/account"),
    ("/watch-together?with=alice&with=bob", "/watch-together"),
    ("/titles/movie/438631?item=9&reply=4", "/titles/:kind/:id"),
    ("/people/alice", "/people/:username"),
    ("/conversations/1b4e28ba-2fa1", "/conversations/:id"),
    ("/join/secret-invitation-token", "/join/:token"),
    ("/api/screenr/screen?path=%2Fpeople%2Falice", "/api/screenr/screen?path=/people/:username"),
    (
      "/api/screenr/screen?path=%2Ftitles%2Fmovie%2F1%3Fitem%3D9&q=dune",
      "/api/screenr/screen?path=/titles/:kind/:id"
    ),
    ("/api/screenr/screen?path=/people/:username", "/api/screenr/screen?path=/people/:username"),
    ("/api/screenr/screen", "/api/screenr/screen"),
    ("/api/screenr/search?q=dune", "/api/screenr/search"),
    ("/api/screenr/top-ten", "/api/screenr/top-ten"),
    ("/api/screenr/Alice%20Smith", "/api/screenr/:action"),
    ("/api/photos/user-alice/3", "/api/photos/:user/:version"),
    ("/api/auth/sign-in/email-otp", "/api/auth/:path"),
    ("/api/auth/reset-password/secret-token", "/api/auth/:path"),
    ("/api/health", "/api/health"),
    ("/.well-known/apple-app-site-association", "/.well-known/apple-app-site-association"),
    ("/people/alice/extra", "/:segment/:segment/:segment"),
    ("/alice", "/:segment"),
    ("/t/p/w500/poster.jpg", "/:segment/:segment/:segment/:segment"),
    ("/titles/movie/438631#comments", "/titles/:kind/:id"),
  ])
  func reducesAPathToItsRoute(path: String, pattern: String) {
    #expect(RoutePattern(path: path).value == pattern)
  }

  @Test func keepsTheOriginOfAnAbsoluteURLAndDropsItsCredentials() throws {
    let url = try #require(
      URL(string: "https://alice:secret@screenr.club:8443/people/alice?q=x#top")
    )

    #expect(RoutePattern(url: url).value == "https://screenr.club:8443/people/:username")
  }

  @Test func reducesAURLWithoutAHostToItsPath() throws {
    let url = try #require(URL(string: "/titles/tv/1399?item=2"))

    #expect(RoutePattern(url: url).value == "/titles/:kind/:id")
  }

  @Test func reducesEveryURLAndPathInText() {
    let text = "Opened https://screenr.club/people/alice?tab=top, then /search?q=dune and/or 1/2"

    #expect(
      RoutePattern.reducingURLs(in: text)
        == "Opened https://screenr.club/people/:username then /search and/or 1/2"
    )
  }
}
