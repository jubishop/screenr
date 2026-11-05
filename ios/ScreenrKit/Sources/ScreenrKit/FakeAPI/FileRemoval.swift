import Dispatch
import Foundation
import System

// Waiting for another process, such as a UI test, to remove a file. The
// system reports the removal, so nothing polls.
enum FileRemoval {
  // Returns once no file is at `url`, at once if there is none.
  static func wait(for url: URL) async throws {
    let descriptor: FileDescriptor
    do {
      descriptor = try FileDescriptor.open(FilePath(url.path()), .readOnly, options: .eventOnly)
    } catch Errno.noSuchFileOrDirectory {
      return
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let source = DispatchSource.makeFileSystemObjectSource(
        fileDescriptor: descriptor.rawValue,
        eventMask: .delete,
        queue: .global()
      )
      source.setEventHandler { source.cancel() }
      source.setCancelHandler { continuation.resume() }
      source.activate()
      // A removal before the source started watching sends no event.
      if !FileManager.default.fileExists(atPath: url.path()) { source.cancel() }
    }
    try descriptor.close()
  }
}
