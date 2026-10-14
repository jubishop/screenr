import Foundation
import Security
import Synchronization

// The Keychain item that holds the session token. The app and its extensions
// share it through the Keychain access group, which is the app group.
public protocol KeychainStorage: Sendable {
  func read() throws(KeychainError) -> String?
  func write(_ token: String) throws(KeychainError)
  func delete() throws(KeychainError)
}

public struct KeychainError: Error, Hashable, Sendable {
  public let status: OSStatus

  public init(status: OSStatus) {
    self.status = status
  }
}

// The system Keychain. The item is readable after the first unlock, so the
// notification extension can read it while the iPhone is locked, and it never
// leaves this device in a backup.
public struct SystemKeychain: KeychainStorage {
  private let accessGroup: String

  public init(accessGroup: String) {
    self.accessGroup = accessGroup
  }

  private var item: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "Screenr session",
      kSecAttrAccount as String: "bearer",
      kSecAttrAccessGroup as String: accessGroup,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  public func read() throws(KeychainError) -> String? {
    var query = item
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = unsafe SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KeychainError(status: status) }
    guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
      throw KeychainError(status: errSecDecode)
    }
    return token
  }

  public func write(_ token: String) throws(KeychainError) {
    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(item as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      let added = SecItemAdd(item.merging(attributes) { _, new in new } as CFDictionary, nil)
      guard added == errSecSuccess else { throw KeychainError(status: added) }
    } else if status != errSecSuccess {
      throw KeychainError(status: status)
    }
  }

  public func delete() throws(KeychainError) {
    let status = SecItemDelete(item as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(status: status)
    }
  }
}

// A Keychain in memory, for tests and the fixture API, which have no
// entitlements and must not touch the device's session.
public final class InMemoryKeychain: KeychainStorage {
  private let token: Mutex<String?>

  public init(token: String? = nil) {
    self.token = Mutex(token)
  }

  public func read() throws(KeychainError) -> String? {
    token.withLock { $0 }
  }

  public func write(_ token: String) throws(KeychainError) {
    self.token.withLock { $0 = token }
  }

  public func delete() throws(KeychainError) {
    token.withLock { $0 = nil }
  }
}
