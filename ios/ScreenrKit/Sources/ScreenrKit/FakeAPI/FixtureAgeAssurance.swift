import Foundation

// Apple's Declared Age Range service for fixture launches, which answers the
// age check at once with the scenario's answer, since UI tests cannot drive
// Apple's sheet or choose the Simulator's region. `record` sees each
// question, for the request log: `required` and `range 18`.
public struct FixtureAgeAssurance: AgeAssurance {
  let age: FixtureScenario.Age
  let record: @Sendable (String) throws -> Void

  public init(
    age: FixtureScenario.Age,
    record: @escaping @Sendable (String) throws -> Void = { _ in }
  ) {
    self.age = age
    self.record = record
  }

  public func isRequired() async throws -> Bool {
    try record("required")
    return age != .notRequired
  }

  public func declaredAge(gate: Int) async throws -> DeclaredAge {
    try record("range \(gate)")
    switch age {
    case .notRequired, .adult: return .shared(lowerBound: 18)
    case .minor: return .shared(lowerBound: 16)
    case .declined: return .declined
    case .failing: throw FixtureError("The fixture age check fails")
    }
  }
}

extension FixtureScenario {
  // What the age check finds: no law requiring it, the default, or a law
  // requiring it and what the person shares.
  public enum Age: String, Hashable, Sendable {
    case notRequired
    // 18 or older.
    case adult
    // 16 or 17.
    case minor
    case declined
    // The service fails when asked for the range.
    case failing
  }
}
