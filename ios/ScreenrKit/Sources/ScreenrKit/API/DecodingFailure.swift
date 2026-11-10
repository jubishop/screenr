import Foundation

// Why a response body did not decode, for logs and error reports: DecodingError's case and the
// coding path to what it could not read, such as `conversations[1].activityAt`. The path holds
// the models' keys and array indexes; no response model decodes a dictionary, whose keys would
// come from the body. DecodingError's description can quote a value, so it is left out.
public struct DecodingFailure: Hashable, Sendable {
  public enum Reason: String, Hashable, Sendable, CaseIterable {
    case typeMismatch
    case valueNotFound
    case keyNotFound
    case dataCorrupted
    // An error other than DecodingError, which a model's own decoding could throw.
    case other
  }

  public let reason: Reason
  // Empty for the body itself, such as a page that is not JSON.
  public let codingPath: String

  init(_ error: any Error) {
    guard let error = error as? DecodingError else {
      self.init(.other, at: [])
      return
    }
    switch error {
    case .typeMismatch(_, let context): self.init(.typeMismatch, at: context.codingPath)
    case .valueNotFound(_, let context): self.init(.valueNotFound, at: context.codingPath)
    case .keyNotFound(let key, let context): self.init(.keyNotFound, at: context.codingPath + [key])
    case .dataCorrupted(let context): self.init(.dataCorrupted, at: context.codingPath)
    @unknown default: self.init(.other, at: [])
    }
  }

  private init(_ reason: Reason, at path: [any CodingKey]) {
    self.reason = reason
    var text = ""
    for key in path {
      if let index = key.intValue {
        text += "[\(index)]"
      } else {
        text += text.isEmpty ? key.stringValue : ".\(key.stringValue)"
      }
    }
    codingPath = text
  }
}
