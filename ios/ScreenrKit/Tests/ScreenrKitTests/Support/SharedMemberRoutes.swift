import Foundation

// `SharedCases/member-routes.json`, beside the server fixtures: member paths
// that the web's member routes, `Destination`, and `RoutePattern` all read,
// so the three cannot drift apart.
enum SharedMemberRoutes {
  struct Case: Decodable {
    let path: String
    // The path that names the same screen with only the parameters it uses.
    let canonical: String
    // The path's route pattern, or nil when it names no member screen.
    let route: String?
  }

  private struct File: Decodable {
    let cases: [Case]
  }

  static func cases() throws -> [Case] {
    let url = TestFixtures.directory
      .deletingLastPathComponent()
      .appending(path: "SharedCases/member-routes.json")
    return try JSONDecoder().decode(File.self, from: try Data(contentsOf: url)).cases
  }
}
