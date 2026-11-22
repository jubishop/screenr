import Testing

@testable import ScreenrKit

// What a feed scrolls into view as a composer takes focus or the keyboard
// rises over it: the whole composer, or the caret first when it does not fit.
struct ComposerRevealTests {
  @Test func showsTheWholeComposerWhenItFits() {
    #expect(ComposerReveal(composer: 220, field: 80, room: 400) == .composer)
    #expect(ComposerReveal(composer: 400, field: 80, room: 400) == .composer)
  }

  // At a large text size, or with a title comment's Season and Episode
  // pickers, the composer can be taller than the room above the keyboard.
  @Test func showsTheFieldWhenTheComposerIsTallerThanTheRoom() {
    #expect(ComposerReveal(composer: 520, field: 300, room: 400) == .field)
    #expect(ComposerReveal(composer: 520, field: 400, room: 400) == .field)
  }

  @Test func leavesTheCaretToTheSystemWhenTheFieldIsTallerThanTheRoom() {
    #expect(ComposerReveal(composer: 900, field: 600, room: 400) == .caret)
  }
}
