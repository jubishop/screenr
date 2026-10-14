import ScreenrKit
import SwiftUI

// What every Settings section reads: the loaded account screen, the signed-in
// member, a way to read the screen again after a change, and a way to open an
// editor sheet. Editor sheets belong to the Settings screen rather than to a
// section, so a failed read, which replaces the sections with the error,
// keeps an open editor and its draft.
struct SettingsContext {
  let page: AccountScreen
  let user: Person
  let screen: ScreenModel
  let open: (SettingsEditor) -> Void

  func refresh() async {
    await screen.refresh()
  }
}

// An editor that Settings shows as a sheet.
enum SettingsEditor: Identifiable {
  case profile(ProfileEditorModel)
  case streamingServices(StreamingServicesModel)
  case feedback(FeedbackModel)
  case deleteAccount(AccountDeletionModel)

  var id: ObjectIdentifier {
    switch self {
    case .profile(let model): ObjectIdentifier(model)
    case .streamingServices(let model): ObjectIdentifier(model)
    case .feedback(let model): ObjectIdentifier(model)
    case .deleteAccount(let model): ObjectIdentifier(model)
    }
  }
}

// A setting's name and value. The value keeps the primary color, since the
// system's gray value color falls short of the audit's contrast check.
struct SettingRow: View {
  let title: String
  let value: String

  init(_ title: String, value: String) {
    self.title = title
    self.value = value
  }

  var body: some View {
    LabeledContent(title) {
      Text(value)
        .foregroundStyle(Color.primary)
    }
  }
}

// A section's footer: the last change's failure, or else what it did. The
// system's footer gray falls short of 4.5:1 contrast, so footers use `.muted`.
struct SettingsFooter: View {
  var text: String?
  var failure: String?
  var status: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let text { Text(text) }
      if let failure {
        FailureLabel(failure)
      } else if let status {
        Text(status)
      }
    }
    .foregroundStyle(.muted)
    .onChange(of: failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
    .onChange(of: status) { _, status in
      if let status { AccessibilityNotification.Announcement(status).post() }
    }
  }
}
