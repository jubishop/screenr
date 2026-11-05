import Foundation
import ScreenrKit
import Security
import Testing

// The system Keychain in the app's own process, with its Keychain access
// group, which package tests have no entitlement for. Each test keeps its
// own item, so the app's session and invitation stay as they are.
struct SystemKeychainTests {
  private let appGroup: String
  private let keychain: SystemKeychain
  private let service = "Screenr test \(UUID().uuidString)"

  init() throws {
    appGroup = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:]).appGroup
    keychain = SystemKeychain(accessGroup: appGroup, service: service, account: "test")
  }

  @Test func writesReadsReplacesAndDeletesAnItem() throws {
    #expect(try keychain.read() == nil)
    try keychain.write("first-token")
    #expect(try keychain.read() == "first-token")
    try keychain.write("second-token")
    #expect(try keychain.read() == "second-token")
    try keychain.delete()
    #expect(try keychain.read() == nil)
    // Deleting an item that is gone succeeds, as signing out twice must.
    try keychain.delete()
  }

  // The extensions read the app's session from the shared access group,
  // and the notification extension reads it while the iPhone is locked, so
  // the item is readable after the first unlock. It never leaves the device.
  @Test func keepsTheItemInTheSharedGroupAfterFirstUnlockOnThisDevice() throws {
    try keychain.write("token")
    let stored: [String: Any]
    do {
      stored = try attributes()
    } catch {
      try keychain.delete()
      throw error
    }
    try keychain.delete()

    #expect(stored[kSecAttrAccessGroup as String] as? String == appGroup)
    #expect(
      stored[kSecAttrAccessible as String] as? String
        == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
    )
    #expect(stored[kSecAttrSynchronizable as String] as? Bool != true)
  }

  // Another process, such as an extension, reads the item through the same
  // group.
  @Test func readsTheItemThatAnotherKeychainWroteInTheGroup() throws {
    try keychain.write("shared-token")
    let other = SystemKeychain(accessGroup: appGroup, service: service, account: "test")
    let read: String?
    do {
      read = try other.read()
    } catch {
      try keychain.delete()
      throw error
    }
    try other.delete()

    #expect(read == "shared-token")
    #expect(try keychain.read() == nil)
  }

  private func attributes() throws -> [String: Any] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "test",
      kSecUseDataProtectionKeychain as String: true,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = unsafe SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let attributes = result as? [String: Any] else {
      throw KeychainError(status: status)
    }
    return attributes
  }
}
