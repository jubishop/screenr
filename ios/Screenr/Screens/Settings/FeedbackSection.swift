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
        .foregroundStyle(.muted)
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
        case .composing, .sending, .sent: break
        }
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
        .foregroundStyle(.muted)
      }
      Section {
        ForEach(Array(model.screenshots.enumerated()), id: \.element.id) { index, screenshot in
          ScreenshotRow(number: index + 1, thumbnail: screenshot.thumbnail) {
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
          .foregroundStyle(.muted)
      }
    }
    .disabled(model.phase == .sending)
    .safeAreaInset(edge: .bottom, spacing: 0) { length }
  }

  // The message's count once it nears Sentry's limit, and an error once it's over, below the form
  // rather than under the field, so they stay in view however long the message grows. The
  // message stays as the member wrote it.
  @ViewBuilder private var length: some View {
    let limit = FeedbackModel.maximumMessageLength
    switch model.messageLength {
    case .short:
      EmptyView()
    case .nearLimit(let count):
      LengthBar {
        Text(verbatim: "\(count) / \(limit)")
      }
    case .overLimit(let count):
      LengthBar {
        Text(verbatim: "\(count) / \(limit)")
          .foregroundStyle(.danger)
        FailureLabel("Shorten your message to 4,096 characters or fewer.")
      }
    }
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

// A strip below the feedback form, in the form's background, for the message's length.
private struct LengthBar<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      content
    }
    .font(.footnote)
    .foregroundStyle(.muted)
    .padding(.horizontal, 32)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: .systemGroupedBackground))
  }
}

// An attached screenshot's thumbnail, which the model decoded once, with its
// own Remove button.
private struct ScreenshotRow: View {
  let number: Int
  let thumbnail: CGImage?
  let remove: () -> Void
  @ScaledMetric(relativeTo: .body) private var height = 64.0

  var body: some View {
    HStack(spacing: 12) {
      if let thumbnail {
        Image(uiImage: UIImage(cgImage: thumbnail))
          .resizable()
          .scaledToFit()
          .frame(height: height)
          .clipShape(.rect(cornerRadius: 6))
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
    }
  }
}
