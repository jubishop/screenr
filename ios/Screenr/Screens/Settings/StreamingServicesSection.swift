import ScreenrKit
import SwiftUI

// The member's streaming services, which shape Find a title and Watch
// together, with an editor sheet.
struct StreamingServicesSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      Button {
        let refresh = settings.refresh
        settings.open(
          .streamingServices(
            StreamingServicesModel(
              services: settings.page.services,
              saved: settings.page.serviceIds,
              api: api
            ) { await refresh() }
          )
        )
      } label: {
        LabeledContent {
          Text(
            StreamingServicesModel.summary(
              services: settings.page.services,
              saved: settings.page.serviceIds
            )
          )
          .foregroundStyle(Color.primary)
        } label: {
          Label("Your services", systemImage: "tv")
        }
      }
      .foregroundStyle(Color.primary)
      .accessibilityHint("Edit your streaming services")
    } header: {
      SectionHeading("Streaming services")
    } footer: {
      Text(
        "Choose the services you have. Free options are always included when finding something to watch."
      )
    }
  }
}

// Choosing services, as a sheet over Settings: a search, the selection, and
// Clear selections. Save keeps the whole selection at once.
struct StreamingServicesSheet: View {
  @Bindable var model: StreamingServicesModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(model.visible) { service in
            let selected = model.selected.contains(service.id)
            Button {
              model.toggle(service.id)
            } label: {
              HStack {
                Text(service.name)
                  .foregroundStyle(.primary)
                Spacer()
                if selected {
                  Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                }
              }
            }
            .accessibilityAddTraits(selected ? .isSelected : [])
          }
          if model.visible.isEmpty {
            Text("No services match that name.")
          }
        } header: {
          SectionHeading("\(model.selected.count) selected")
        } footer: {
          if let failure = model.failure { FailureLabel(failure) }
        }
      }
      .searchable(text: $model.query, placement: .navigationBarDrawer, prompt: "Find a service")
      .navigationTitle("Streaming services")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() }
            .disabled(model.state == .saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.state == .saving {
            ProgressView()
              .accessibilityLabel("Saving")
          } else {
            Button("Save", systemImage: "checkmark", role: .confirm) { save() }
              .disabled(!model.canEdit)
          }
        }
        ToolbarItem(placement: .bottomBar) {
          Button("Clear selections") { model.clear() }
            .disabled(!model.canEdit || model.selected.isEmpty)
        }
      }
      .interactiveDismissDisabled(model.state == .saving)
      .onChange(of: model.failure) { _, failure in
        if let failure { AccessibilityNotification.Announcement(failure).post() }
      }
    }
  }

  private func save() {
    Task {
      await model.save()
      guard model.state == .saved else { return }
      AccessibilityNotification.Announcement("Services saved.").post()
      dismiss()
    }
  }
}
