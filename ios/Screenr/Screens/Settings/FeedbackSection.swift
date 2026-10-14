import PhotosUI
import ScreenrKit
import SwiftUI

// Send feedback, which opens the feedback form.
struct FeedbackSection: View {
  let settings: SettingsContext
  @Environment(\.feedbackService) private var feedback

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      Button {
        settings.open(.feedback(FeedbackModel(service: feedback)))
      } label: {
        Label("Send feedback", systemImage: "exclamationmark.bubble")
      }
    } header: {
      SectionHeading("Feedback")
    } footer: {
      Text("Tell us what works, what doesn't, and what you'd like Screenr to do.")
    }
  }
}

// The feedback form, as a sheet over Settings: a message and up to three screenshots, sent with
// recent app logs to Sentry, the service that collects Screenr's error reports. After sending,
// it thanks the member. Against the fixture API, Attach screenshots chooses `FixturePhoto`
// instead of opening the library.
struct FeedbackSheet: View {
  @Bindable var model: FeedbackModel
  @State private var selection: [PhotosPickerItem] = []
  @FocusState private var writing: Bool
  @Environment(\.photoLibrary) private var library
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if model.phase == .sent {
          MessageView(
            title: "Thanks for your feedback",
            systemImage: "checkmark.circle",
            message: "It's on its way to the people who make Screenr."
          )
        } else {
          form
        }
      }
      .navigationTitle("Send feedback")
      .toolbarTitleDisplayMode(.inline)
      .toolbar { toolbar }
      .interactiveDismissDisabled(model.hasDraft)
      .onChange(of: selection) { _, items in
        guard !items.isEmpty else { return }
        selection = []
        let loads = items.map { item -> @Sendable () async throws -> Data? in
          { try await item.loadTransferable(type: Data.self) }
        }
        Task { await model.attach(loads) }
      }
      .onChange(of: model.phase) { _, phase in
        switch phase {
        // The keyboard makes way for the screenshots.
        case .attaching: writing = false
        case .sent: AccessibilityNotification.Announcement("Feedback sent.").post()
        case .composing, .sending: break
        }
      }
      .onChange(of: model.failure) { _, failure in
        if let failure { AccessibilityNotification.Announcement(failure).post() }
      }
    }
  }

  private var form: some View {
    Form {
      if model.availability == .unavailable {
        Section {
          Label(
            "Screenr Dev sends no feedback, since it never starts Sentry. Send feedback from a TestFlight build.",
            systemImage: "info.circle"
          )
        }
      }
      if let failure = model.failure {
        Section {
          FailureLabel(failure)
        }
      }
      Section {
        TextField("Your feedback", text: $model.message, axis: .vertical)
          .lineLimit(5...)
          .focused($writing)
      } header: {
        SectionHeading("Your feedback")
      } footer: {
        Text(
          "Recent app logs go with your feedback. They show what the app did, such as which screens loaded, and never what anyone wrote."
        )
      }
      Section {
        ForEach(Array(model.screenshots.enumerated()), id: \.element.id) { index, screenshot in
          ScreenshotRow(number: index + 1, jpeg: screenshot.jpeg) {
            model.remove(screenshot.id)
          }
        }
        if model.phase == .attaching {
          ProgressView("Attaching…")
        } else if model.remainingScreenshots > 0 {
          attachButton
        }
      } header: {
        SectionHeading("Screenshots")
      } footer: {
        Text("Attach up to \(FeedbackModel.maximumScreenshots) screenshots.")
      }
    }
    .disabled(model.phase == .sending)
  }

  @ViewBuilder private var attachButton: some View {
    switch library {
    case .system:
      PhotosPicker(
        selection: $selection,
        maxSelectionCount: model.remainingScreenshots,
        selectionBehavior: .ordered,
        matching: .screenshots
      ) {
        Label("Attach screenshots", systemImage: "photo.badge.plus")
      }
    case .fixture:
      // UI tests cannot drive the photo picker, so against the fixture API
      // the button attaches a stand-in image.
      Button {
        Task { await model.attach([{ try FixturePhoto.jpeg() }]) }
      } label: {
        Label("Attach screenshots", systemImage: "photo.badge.plus")
      }
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if model.phase == .sent {
      ToolbarItem(placement: .confirmationAction) {
        Button("Done", systemImage: "checkmark", role: .confirm) { dismiss() }
      }
    } else {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() }
          .disabled(model.phase == .sending)
      }
      ToolbarItem(placement: .confirmationAction) {
        if model.phase == .sending {
          ProgressView()
            .accessibilityLabel("Sending")
        } else {
          Button("Send", systemImage: "paperplane", role: .confirm) {
            Task { await model.send() }
          }
          .disabled(!model.canSend)
        }
      }
    }
  }
}

// An attached screenshot's thumbnail, with its own Remove button.
private struct ScreenshotRow: View {
  let number: Int
  let jpeg: Data
  let remove: () -> Void
  @ScaledMetric(relativeTo: .body) private var height = 64.0

  var body: some View {
    HStack(spacing: 12) {
      if let image = UIImage(data: jpeg) {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(height: height)
          .clipShape(.rect(cornerRadius: 6))
          .accessibilityHidden(true)
      }
      Text("Screenshot \(number)")
      Spacer()
      Button(role: .destructive, action: remove) {
        Image(systemName: "xmark.circle.fill")
          .font(.title2)
          .foregroundStyle(.danger)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Remove screenshot \(number)")
    }
  }
}
