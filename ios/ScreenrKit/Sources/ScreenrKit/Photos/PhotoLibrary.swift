import Foundation

// Where the photo editor gets a photo: the system's photo picker, or under
// the fixture API, `FixturePhoto`, since UI tests cannot drive the picker.
public enum PhotoLibrary: Hashable, Sendable {
  case system
  case fixture
}
