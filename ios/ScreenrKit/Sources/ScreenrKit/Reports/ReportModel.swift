import Foundation
import Observation

// Reporting another member's post, comment, review, or profile for Screenr's
// owner to review, as on the web:
//
// - The form needs one of the reasons, and takes an optional note of up to
//   500 characters, as the server counts them.
// - A failed report keeps the form open with the server's words.
// - A sent report closes the form and reads the screen again, which no
//   longer shows a reported post, comment, or review to the reporter.
// - Once the form has closed, an offer suggests blocking the author too.
//   Block sends `relationship`'s block and reads the screen again, unless
//   the screen is the author's own page, such as their profile, which
//   blocking them closes; `leave` blocks them there.
//
// The screen keeps the model outside its content, so the form, its draft,
// and the offer outlive failed reads.
@MainActor
@Observable
public final class ReportModel {
  public enum Phase: Hashable, Sendable {
    // Choosing a reason and writing an optional note.
    case editing
    case sending
    // The server's reason the report did not send, shown in the form.
    case failed(String)
    // Sent, so the form closes, and the offer waits for it to close.
    case sent(ReportSubject)
  }

  // What the screen asks after a report.
  public enum Prompt: Hashable, Sendable, Identifiable {
    // Block the reported content's author too?
    case offer(ReportSubject)
    // Block from the offer failed, in the server's words.
    case blockFailed(Person, String)

    public var id: Self { self }

    public var title: String {
      switch self {
      case .offer: "Thanks for reporting"
      case .blockFailed(let person, _): "Couldn’t block \(person.displayName)"
      }
    }

    public var message: String {
      switch self {
      case .offer(let subject):
        "Screenr’s owner will review it. Block \(subject.author.displayName) too? You won’t see "
          + "each other’s profiles, posts, or comments, and neither of you can send a friend "
          + "request until you unblock them."
      case .blockFailed(_, let message): message
      }
    }
  }

  // In UTF-16 code units, as the server counts with JavaScript's `length`.
  public static let noteLimit = 500

  // The open form's subject, which the screen presents as a sheet.
  public var form: ReportSubject?
  public private(set) var reason: ReportReason?
  public private(set) var note = ""
  public private(set) var phase = Phase.editing
  public var prompt: Prompt?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void
  @ObservationIgnored private let leave: @MainActor (Person) async -> Bool

  // `refresh` reads the screen again. `leave` blocks a person whose own page
  // the screen is, as that page's Block does, and says whether it did.
  public init(
    api: any ScreenrAPI,
    refresh: @escaping @MainActor () async -> Void,
    leave: @escaping @MainActor (Person) async -> Bool = { _ in false }
  ) {
    self.api = api
    self.refresh = refresh
    self.leave = leave
  }

  // Opens an empty form, unless a report is still sending.
  public func open(_ subject: ReportSubject) {
    guard phase != .sending else { return }
    form = subject
    reason = nil
    note = ""
    phase = .editing
  }

  public func choose(_ reason: ReportReason) {
    self.reason = reason
  }

  // The note, cut to the limit as typing it would be.
  public func setNote(_ note: String) {
    self.note = note.prefix(utf16Limit: Self.noteLimit)
  }

  public var canSend: Bool {
    form != nil && reason != nil && phase != .sending
  }

  // Cancel, which a sending report waits out.
  public func cancel() {
    guard phase != .sending else { return }
    form = nil
  }

  // Sends the report with its trimmed note, or none when the note is blank.
  public func send() async {
    guard canSend, let subject = form, let reason else { return }
    phase = .sending
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    do throws(APIError) {
      _ = try await api.send(
        .report(subject.content, reason: reason, note: trimmed.isEmpty ? nil : trimmed)
      )
    } catch {
      phase = error.kind == .cancelled ? .editing : .failed(error.explanation)
      return
    }
    phase = .sent(subject)
    form = nil
    await refresh()
  }

  // The form's sheet has closed. After a report, the offer to block its
  // author shows now, once the sheet no longer covers the screen.
  public func formClosed() {
    guard case .sent(let subject) = phase else { return }
    phase = .editing
    prompt = .offer(subject)
  }

  public func dismissPrompt() {
    prompt = nil
  }

  // Block, from the offer after reporting `subject`.
  public func block(_ subject: ReportSubject) async {
    if prompt == .offer(subject) { prompt = nil }
    let person = subject.author
    if await leave(person) { return }
    do throws(APIError) {
      _ = try await api.send(.relationship(target: person.userId, .block))
    } catch {
      if error.kind != .cancelled { prompt = .blockFailed(person, error.explanation) }
      return
    }
    await refresh()
  }
}
