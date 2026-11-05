import Foundation

// The services an extension keeps from one request to the next, since iOS may
// run several pushes or shares in one process, and new connections cost each
// one its own TCP and TLS setup. They last while the Keychain holds the
// session token they read and the launch arguments stay the same. Once the
// member signs in or out in the app, or Screenr Dev's app launches with other
// fixtures, the next request gets new services, and the replaced ones close
// their connections when no request uses them.
@MainActor
public final class ExtensionServices {
  private final class Kept {
    let arguments: [String]
    let services: AppServices
    var requests = 0
    var replaced = false

    init(arguments: [String], services: AppServices) {
      self.arguments = arguments
      self.services = services
    }
  }

  private let make: @MainActor (_ arguments: [String]) throws -> AppServices
  private var kept: Kept?

  // `make` builds the services for an extension launched with `arguments`.
  public init(_ make: @escaping @MainActor (_ arguments: [String]) throws -> AppServices) {
    self.make = make
  }

  // Runs `request` with the kept services, or with new ones that replace
  // them. It throws only when new services cannot start.
  public func run(
    arguments: [String],
    _ request: @MainActor (AppServices) async -> Void
  ) async throws {
    let kept = try services(arguments: arguments)
    kept.requests += 1
    await request(kept.services)
    kept.requests -= 1
    if kept.replaced, kept.requests == 0 { kept.services.close() }
  }

  private func services(arguments: [String]) throws -> Kept {
    if let kept, kept.arguments == arguments, Self.isCurrent(kept.services) { return kept }
    if let kept {
      kept.replaced = true
      if kept.requests == 0 { kept.services.close() }
      self.kept = nil
    }
    let fresh = Kept(arguments: arguments, services: try make(arguments))
    kept = fresh
    return fresh
  }

  // A Keychain that cannot be read counts as changed, so the new services'
  // own read reports the failure.
  private static func isCurrent(_ services: AppServices) -> Bool {
    do {
      return try services.session.isCurrent()
    } catch {
      return false
    }
  }
}
