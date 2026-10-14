import Foundation
import Testing

@testable import ScreenrKit

struct AppleSignInTests {
  @Test func hashesTheNonceForApple() {
    // SHA-256 of "abc", from FIPS 180-2.
    #expect(
      AppleNonce(raw: "abc").hashed
        == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  }

  @Test func makesANewNonceForEachRequest() {
    let first = AppleNonce()
    let second = AppleNonce()

    #expect(first.raw.count == 43)
    #expect(first.raw != second.raw)
    #expect(first.hashed.count == 64)
  }

  @Test func readsTheCredentialApple() throws {
    var name = PersonNameComponents()
    name.givenName = "Pat"
    name.familyName = " "

    let credential = try #require(
      AppleCredential(
        identityToken: Data("identity".utf8),
        authorizationCode: Data("code".utf8),
        fullName: name
      )
    )

    #expect(credential.identityToken == "identity")
    #expect(credential.authorizationCode == "code")
    #expect(credential.name == AppleName(first: "Pat", last: nil))
  }

  @Test func leavesOutTheNameAfterTheFirstAuthorization() throws {
    let credential = try #require(
      AppleCredential(
        identityToken: Data("identity".utf8),
        authorizationCode: Data("code".utf8),
        fullName: PersonNameComponents()
      )
    )

    #expect(credential.name == nil)
  }

  @Test func needsTheTokenAndTheCode() {
    let token = Data("identity".utf8)
    let code = Data("code".utf8)

    #expect(AppleCredential(identityToken: nil, authorizationCode: code, fullName: nil) == nil)
    #expect(AppleCredential(identityToken: token, authorizationCode: nil, fullName: nil) == nil)
    #expect(AppleCredential(identityToken: Data(), authorizationCode: code, fullName: nil) == nil)
  }
}
