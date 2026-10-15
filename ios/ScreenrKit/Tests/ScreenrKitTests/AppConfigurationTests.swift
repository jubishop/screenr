import Foundation
import ScreenrKit
import Testing

struct AppConfigurationTests {
  private let dev: [String: Any] = [
    "ScreenrVariant": "dev",
    "ScreenrServerURL": "http://localhost:3000",
    "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
    "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
    "CFBundleIdentifier": "com.artisanalsoftware.Screenr.dev",
    "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": "7",
    "ScreenrAPSEnvironment": "development",
  ]

  @Test func readsTheBuildSettingsFromTheInfoDictionary() throws {
    let configuration = try AppConfiguration(infoDictionary: dev)

    #expect(configuration.variant == .dev)
    #expect(configuration.serverURL.absoluteString == "http://localhost:3000")
    #expect(configuration.appGroup == "group.com.artisanalsoftware.Screenr.dev")
    #expect(configuration.googleClientID == "1083-abc.apps.googleusercontent.com")
    #expect(configuration.version == "1.0")
    #expect(configuration.build == "7")
  }

  @Test func namesTheBuildInTheClientHeader() throws {
    #expect(try AppConfiguration(infoDictionary: dev).clientHeader == "ios/1.0/7")
  }

  // A device token belongs to the APNs environment of the build's aps-environment
  // entitlement, which the same build setting writes to the Info.plist.
  @Test func namesTheDeviceTokensEnvironmentTopicAndBuild() throws {
    #expect(
      try AppConfiguration.pushTarget(infoDictionary: dev)
        == PushTarget(environment: .sandbox, topic: "com.artisanalsoftware.Screenr.dev", build: 7)
    )
    var release = dev
    release["ScreenrAPSEnvironment"] = "production"
    release["CFBundleIdentifier"] = "com.artisanalsoftware.Screenr"
    #expect(
      try AppConfiguration.pushTarget(infoDictionary: release)
        == PushTarget(environment: .production, topic: "com.artisanalsoftware.Screenr", build: 7)
    )
  }

  // Extensions, such as the share extension, receive no pushes and carry no
  // APNs environment.
  @Test func readsAnExtensionsSettingsWithoutThePushTarget() throws {
    var info = dev
    info["CFBundleIdentifier"] = nil
    info["ScreenrAPSEnvironment"] = nil

    #expect(try AppConfiguration(infoDictionary: info).build == "7")
  }

  @Test(arguments: ["CFBundleIdentifier", "CFBundleVersion", "ScreenrAPSEnvironment"])
  func reportsAMissingPushValue(key: String) {
    var info = dev
    info[key] = nil

    #expect(throws: AppConfiguration.Failure.missingValue(key: key)) {
      try AppConfiguration.pushTarget(infoDictionary: info)
    }
  }

  @Test(arguments: [
    ("CFBundleIdentifier", ""),
    ("CFBundleIdentifier", "com.artisanalsoftware.Screenr dev"),
    ("CFBundleVersion", "0"),
    ("ScreenrAPSEnvironment", "sandbox"),
  ])
  func reportsAnInvalidPushValue(key: String, value: String) {
    var info = dev
    info[key] = value

    #expect(throws: AppConfiguration.Failure.invalidValue(key: key)) {
      try AppConfiguration.pushTarget(infoDictionary: info)
    }
  }

  @Test func acceptsTheReleaseServer() throws {
    var release = dev
    release["ScreenrVariant"] = "release"
    release["ScreenrServerURL"] = "https://screenr.club"

    let configuration = try AppConfiguration(infoDictionary: release)

    #expect(configuration.variant == .release)
    #expect(configuration.serverURL.absoluteString == "https://screenr.club")
  }

  @Test func rejectsAnInsecureReleaseServer() {
    var release = dev
    release["ScreenrVariant"] = "release"

    #expect(throws: AppConfiguration.Failure.invalidValue(key: "ScreenrServerURL")) {
      try AppConfiguration(infoDictionary: release)
    }
  }

  @Test(arguments: [
    "ScreenrVariant", "ScreenrServerURL", "ScreenrAppGroup", "ScreenrGoogleClientID",
    "CFBundleShortVersionString", "CFBundleVersion",
  ])
  func reportsAMissingValue(key: String) {
    var info = dev
    info[key] = nil

    #expect(throws: AppConfiguration.Failure.missingValue(key: key)) {
      try AppConfiguration(infoDictionary: info)
    }
  }

  @Test(arguments: [
    ("ScreenrVariant", "staging"),
    ("ScreenrServerURL", "localhost"),
    ("ScreenrAppGroup", ""),
    ("ScreenrGoogleClientID", ""),
    ("ScreenrGoogleClientID", ".apps.googleusercontent.com"),
    ("ScreenrGoogleClientID", "1083-abc"),
    ("ScreenrGoogleClientID", "1083 abc.apps.googleusercontent.com"),
    ("CFBundleShortVersionString", ""),
    ("CFBundleShortVersionString", "1.0 beta"),
    ("CFBundleVersion", "1.2"),
    ("CFBundleVersion", "1234567890123456"),
    ("CFBundleVersion", "0"),
  ])
  func reportsAnInvalidValue(key: String, value: String) {
    var info = dev
    info[key] = value

    #expect(throws: AppConfiguration.Failure.invalidValue(key: key)) {
      try AppConfiguration(infoDictionary: info)
    }
  }
}
