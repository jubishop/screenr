import ScreenrKit
import Testing

struct IncomingActivityTests {
  @Test func acceptsTheFirstSnapshotAsAWhole() {
    var activity = IncomingActivity<String>()
    #expect(!activity.isShown("entry-1"))

    activity.receive(["entry-1", "entry-2"])

    #expect(activity.isShown("entry-1"))
    #expect(activity.isShown("entry-2"))
    #expect(activity.waiting.isEmpty)
  }

  @Test func holdsOtherPeoplesNewActivityUntilTheReaderAcceptsIt() {
    var activity = IncomingActivity<String>()
    activity.receive(["entry-1"])

    activity.receive(["entry-1", "entry-2", "reply-3"])

    #expect(!activity.isShown("entry-2"))
    #expect(activity.waiting == ["entry-2", "reply-3"])
    activity.acceptWaiting()
    #expect(activity.isShown("entry-2"))
    #expect(activity.isShown("reply-3"))
    #expect(activity.waiting.isEmpty)
  }

  @Test func showsTheReadersOwnActivityAtOnce() {
    var activity = IncomingActivity<String>()
    activity.receive(["entry-1"])

    activity.receive(["entry-1", "mine", "theirs"], own: ["mine"])

    #expect(activity.isShown("mine"))
    #expect(activity.waiting == ["theirs"])
  }

  @Test func forgetsWaitingActivityThatDisappears() {
    var activity = IncomingActivity<String>()
    activity.receive(["entry-1"])
    activity.receive(["entry-1", "removed"])

    activity.receive(["entry-1"])

    #expect(activity.waiting.isEmpty)
  }

  @Test func acceptsOneWaitingItem() {
    var activity = IncomingActivity<String>()
    activity.receive([])
    activity.receive(["entry-1", "entry-2"])

    activity.accept("entry-1")

    #expect(activity.isShown("entry-1"))
    #expect(activity.waiting == ["entry-2"])
  }
}
