import PhotosUI
import ScreenrKit
import SwiftUI

// The signed-in member's own photo, which setup and Settings share: the photo
// or initial, and controls to add or replace it from the photo library, use
// the Google account's picture, or remove it, as on the web. Each change
// saves at once, and its result is announced. Against the fixture API, Add
// and Replace photo choose `FixturePhoto` instead of opening the library.
struct ProfilePhotoEditor: View {
  let model: ProfilePhotoModel
  // The name whose initial shows without a photo.
  let name: String
  @State private var selection: PhotosPickerItem?
  @Environment(\.photoLibrary) private var library
  @ScaledMetric(relativeTo: .body) private var photoSize = 72.0

  var body: some View {
    // The picker builds its label away from the main actor.
    let pickTitle =
      model.activity == .uploading ? "Saving…" : model.hasPhoto ? "Replace photo" : "Add photo"
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 16) {
        ProfilePhotoView(jpeg: model.jpeg, name: name, size: photoSize)
        Text(
          model.hasPhoto
            ? "Members who can see your profile see this photo."
            : "Your initial shows until you add a photo."
        )
        .font(.subheadline)
      }
      switch library {
      case .system:
        PhotosPicker(selection: $selection, matching: .images) {
          Label(pickTitle, systemImage: "photo.on.rectangle")
        }
      case .fixture:
        // UI tests cannot drive the photo picker, so against the fixture API
        // the button chooses a stand-in photo.
        Button {
          Task { await model.upload { try FixturePhoto.jpeg() } }
        } label: {
          Label(pickTitle, systemImage: "photo.on.rectangle")
        }
      }
      if model.google {
        Button {
          Task { await model.useGoogle() }
        } label: {
          Label(
            model.activity == .copyingGoogle ? "Copying…" : "Use my Google photo",
            systemImage: "g.circle"
          )
        }
      }
      if model.hasPhoto {
        Button(role: .destructive) {
          Task { await model.remove() }
        } label: {
          Label(model.activity == .removing ? "Removing…" : "Remove photo", systemImage: "trash")
        }
      }
      if let status = model.status {
        Text(status)
          .font(.footnote)
      }
      if let failure = model.failure {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.red)
            .accessibilityHidden(true)
          Text(failure)
        }
        .font(.callout)
      }
    }
    .buttonStyle(.bordered)
    .disabled(model.activity != .idle)
    .task(id: model.version) { await model.loadPhoto() }
    .onChange(of: selection) { _, item in
      guard let item else { return }
      selection = nil
      Task { await model.upload { try await item.loadTransferable(type: Data.self) } }
    }
    .onChange(of: model.status) { _, status in
      if let status { AccessibilityNotification.Announcement(status).post() }
    }
    .onChange(of: model.failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
  }
}
