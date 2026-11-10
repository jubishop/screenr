import Foundation
import Testing

@testable import ScreenrKit

// The launch's age check, against a fake of Apple's Declared Age Range
// service.
@MainActor
struct AgeCheckTests {
  // Answers as the test sets it up, and records each gate the check asks
  // about.
  @MainActor
  final class FakeAgeAssurance: AgeAssurance {
    struct Failure: Error {}

    var required: Result<Bool, Failure>
    var answers: [Result<DeclaredAge, Failure>]
    private(set) var gates: [Int] = []

    init(required: Result<Bool, Failure> = .success(true), answers: [DeclaredAge] = []) {
      self.required = required
      self.answers = answers.map { .success($0) }
    }

    func isRequired() async throws -> Bool {
      try Task.checkCancellation()
      return try required.get()
    }

    func declaredAge(gate: Int) async throws -> DeclaredAge {
      gates.append(gate)
      guard !answers.isEmpty else {
        Issue.record("The check asked for an age range more times than the test expected")
        throw Failure()
      }
      return try answers.removeFirst().get()
    }
  }

  @Test func neverAsksWhereTheLawDoesNotRequireIt() async {
    let service = FakeAgeAssurance(required: .success(false))
    let check = AgeCheck()

    #expect(check.phase == .checking)
    await check.check(using: service)

    #expect(check.phase == .allowed)
    #expect(service.gates.isEmpty)
  }

  @Test(arguments: [18, 21])
  func allowsAnAdultWhereTheLawRequiresIt(lowerBound: Int) async {
    let service = FakeAgeAssurance(answers: [.shared(lowerBound: lowerBound)])
    let check = AgeCheck()

    await check.check(using: service)

    #expect(check.phase == .allowed)
    #expect(service.gates == [18])
  }

  // A range that starts below 18 doesn't show the person is an adult, and
  // one with no lower bound starts below the lowest gate.
  @Test(arguments: [nil, 13, 16, 17])
  func refusesAMinor(lowerBound: Int?) async {
    let service = FakeAgeAssurance(answers: [.shared(lowerBound: lowerBound)])
    let check = AgeCheck()

    await check.check(using: service)

    #expect(check.phase == .refused(.minor))
  }

  @Test func refusesSomeoneWhoDeclinesToShare() async {
    let service = FakeAgeAssurance(answers: [.declined])
    let check = AgeCheck()

    await check.check(using: service)

    #expect(check.phase == .refused(.declined))
  }

  // Without knowing whether the law applies, the check can't let anyone in.
  @Test func refusesWhenTheServiceCannotSayWhetherTheLawApplies() async {
    let service = FakeAgeAssurance(required: .failure(FakeAgeAssurance.Failure()))
    let check = AgeCheck()

    await check.check(using: service)

    #expect(check.phase == .refused(.failed))
    #expect(service.gates.isEmpty)
  }

  @Test func refusesWhenAskingForTheAgeRangeFails() async {
    let service = FakeAgeAssurance()
    service.answers = [.failure(FakeAgeAssurance.Failure())]
    let check = AgeCheck()

    await check.check(using: service)

    #expect(check.phase == .refused(.failed))
  }

  // Someone who declined can share their age range in Settings, then try
  // again.
  @Test func checksAgainOnRetry() async {
    let service = FakeAgeAssurance(answers: [.declined, .shared(lowerBound: 18)])
    let check = AgeCheck()
    await check.check(using: service)

    check.retry()
    #expect(check.phase == .checking)
    await check.check(using: service)

    #expect(check.phase == .allowed)
    #expect(service.gates == [18, 18])
  }

  // Each check runs once: SwiftUI can run the checking view's task again,
  // such as when the view reappears, and nothing asks once it passed.
  @Test func checksOnlyWhileChecking() async {
    let service = FakeAgeAssurance(answers: [.shared(lowerBound: 18)])
    let check = AgeCheck()
    await check.check(using: service)

    await check.check(using: service)
    check.retry()

    #expect(check.phase == .allowed)
    #expect(service.gates == [18])
  }

  // A check whose view went away mid-check is no failure: the phase stays,
  // so the check runs again when the view returns.
  @Test func keepsCheckingWhenCancelled() async {
    let service = FakeAgeAssurance(answers: [.shared(lowerBound: 18)])
    let check = AgeCheck()

    let task = Task { await check.check(using: service) }
    task.cancel()
    await task.value

    #expect(check.phase == .checking)
    await check.check(using: service)
    #expect(check.phase == .allowed)
  }

  // Fixture launches answer from the scenario, not Apple's service, which UI
  // tests cannot drive.
  @Test func answersFromTheFixtureInFixtureLaunches() async {
    let expected: [(FixtureScenario.Age, AgeCheck.Phase)] = [
      (.notRequired, .allowed),
      (.adult, .allowed),
      (.minor, .refused(.minor)),
      (.declined, .refused(.declined)),
      (.failing, .refused(.failed)),
    ]
    for (age, phase) in expected {
      let system = FakeAgeAssurance(answers: [.shared(lowerBound: 18)])
      let check = AgeCheck(fixture: FixtureAgeAssurance(age: age))

      await check.check(using: system)

      #expect(check.phase == phase, "\(age)")
      #expect(system.gates.isEmpty, "\(age)")
    }
  }

  // Fixture launches' services answer from the launch arguments' age, and
  // write each question to the request log, where UI tests see whether the
  // app asked.
  @Test func fixtureServicesAnswerAndLogTheAge() async throws {
    let configuration = try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
    let expected: [([String], AgeCheck.Phase, String)] = [
      ([], .allowed, "AGE required\n"),
      (["-ScreenrFixtureAge", "minor"], .refused(.minor), "AGE required\nAGE range 18\n"),
    ]
    for (age, phase, lines) in expected {
      let log = FileManager.default.temporaryDirectory
        .appending(path: "age-check-\(UUID().uuidString).log")
      defer {
        do {
          try FileManager.default.removeItem(at: log)
        } catch {
          Issue.record("Could not remove \(log.path()): \(error)")
        }
      }
      let services = try AppServices(
        configuration: configuration,
        arguments: [
          "Screenr", "-ScreenrFixtures", TestFixtures.directory.path(), "-ScreenrFixtureLog",
          log.path(),
        ] + age
      )
      let system = FakeAgeAssurance(answers: [.shared(lowerBound: 18)])

      await services.ageCheck.check(using: system)

      #expect(services.ageCheck.phase == phase, "\(age)")
      #expect(try String(contentsOf: log, encoding: .utf8) == lines, "\(age)")
      #expect(system.gates.isEmpty, "\(age)")
    }
  }

  @Test func readsTheFixtureAgeFromTheLaunchArguments() throws {
    let directory = URL(filePath: "/f", directoryHint: .isDirectory)
    let plain = try APISource(arguments: ["Screenr", "-ScreenrFixtures", "/f"], variant: .dev)
    #expect(plain == .fixtures(directory: directory, scenario: FixtureScenario()))
    #expect(FixtureScenario().age == .notRequired)

    for age in ["notRequired", "adult", "minor", "declined", "failing"] {
      let source = try APISource(
        arguments: ["Screenr", "-ScreenrFixtures", "/f", "-ScreenrFixtureAge", age],
        variant: .dev
      )
      guard case .fixtures(_, let scenario) = source else {
        Issue.record("Expected the fixture API")
        return
      }
      #expect(scenario.age.rawValue == age)
    }
    #expect(throws: APISource.ArgumentError.self) {
      try APISource(arguments: ["Screenr", "-ScreenrFixtureAge", "teen"], variant: .dev)
    }
  }
}
