import Foundation

// One recorded API exchange from `ScreenrKit/Fixtures`, which server tests
// write. `name` is its path there without `.json`, such as `screen/feed/empty`.
public struct Fixture: Hashable, Sendable {
  public struct Request: Decodable, Hashable, Sendable {
    public struct Upload: Decodable, Hashable, Sendable {
      public let contentType: String
      public let bytes: Int
    }

    public let method: HTTPMethod
    public let action: String
    public let path: String
    public let query: [String: String]?
    public let body: JSONValue?
    public let upload: Upload?
    public let headers: [String: String]?
  }

  public struct Response: Decodable, Hashable, Sendable {
    public let status: Int
    public let etag: String?
    // Null for a 304.
    public let body: JSONValue?
  }

  public let name: String
  public let description: String
  // The signed-in member's username, or nil without a session.
  public let viewer: String?
  public let request: Request
  public let response: Response

  private struct File: Decodable {
    let description: String
    let viewer: String?
    let request: Request
    let response: Response
  }

  public init(name: String, data: Data) throws {
    // Plain keys: the bodies keep the server's snake_case names.
    let file = try JSONDecoder().decode(File.self, from: data)
    self.name = name
    description = file.description
    viewer = file.viewer
    request = file.request
    response = file.response
  }

  // Every fixture in a directory, sorted by name.
  public static func all(in directory: URL) throws -> [Fixture] {
    let root = directory.resolvingSymlinksInPath().pathComponents
    guard
      let files = FileManager.default.enumerator(
        at: directory,
        includingPropertiesForKeys: nil
      )
    else { throw FixtureError("Cannot read the fixtures in \(directory.path())") }
    var fixtures: [Fixture] = []
    for case let file as URL in files where file.pathExtension == "json" {
      let parts = file.resolvingSymlinksInPath().deletingPathExtension().pathComponents
      let name = parts.dropFirst(root.count).joined(separator: "/")
      do {
        fixtures.append(try Fixture(name: name, data: try Data(contentsOf: file)))
      } catch {
        throw FixtureError("Cannot read the fixture \(name): \(error)")
      }
    }
    guard !fixtures.isEmpty else {
      throw FixtureError("There are no fixtures in \(directory.path())")
    }
    return fixtures.sorted { $0.name < $1.name }
  }
}

public struct FixtureError: Error, Hashable, Sendable, CustomStringConvertible {
  public let description: String

  init(_ description: String) {
    self.description = description
  }
}
