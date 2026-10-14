import ScreenrKit
import SwiftUI

// A shared title: its poster, name, and synopsis, the member's Recommend and
// Want to watch, which read the title page for where the member stands, and
// which friends recommend it or want to watch it.
struct ShareTitleView: View {
  let title: Title
  @Environment(\.screenrAPI) private var api

  var body: some View {
    ShareTitlePage(model: ShareTitleModel(title: title, api: api))
  }
}

// The model lives here, so a page read keeps what the member is doing.
private struct ShareTitlePage: View {
  @State private var model: ShareTitleModel
  @Environment(\.dynamicTypeSize) private var typeSize

  init(model: ShareTitleModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    let actions = model.actions
    // Large text stacks the poster above the name.
    let layout =
      typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
      : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
    List {
      Section {
        layout {
          SharePoster(title: model.title, width: 80)
          VStack(alignment: .leading, spacing: 4) {
            Text(model.title.kindAndYear)
              .font(.subheadline.weight(.semibold))
            Text(model.title.name)
              .font(.title2.bold())
              .accessibilityAddTraits(.isHeader)
          }
        }
        if !model.title.overview.isEmpty {
          Text(model.title.overview)
        }
      }
      Section {
        switch model.screen.phase {
        case .loading:
          ProgressView()
            .frame(maxWidth: .infinity)
        case .failed(let error):
          Label(error.readExplanation, systemImage: "exclamationmark.triangle")
          Button("Try again") { Task { await model.load() } }
        case .loaded:
          if let header = model.header {
            ShareTitleActions(model: model, header: header)
          }
          if let friends = model.page?.friends, !friends.isEmpty {
            Text(friends.sentence)
              .font(.subheadline)
          }
        }
      }
    }
    .task { await model.load() }
    .onChange(of: model.header) { _, header in
      if let header { actions.reconcile(with: header) }
    }
    .confirmationDialog(
      actions.leaving?.message ?? "",
      isPresented: Binding(
        get: { actions.leaving != nil },
        set: { presented in if !presented { actions.leaving = nil } }
      ),
      titleVisibility: .visible,
      presenting: actions.leaving
    ) { leaving in
      Button(leaving.action, role: .destructive) {
        guard let header = model.header else { return }
        Task { await actions.confirm(leaving, for: header) }
      }
      Button("Cancel", role: .cancel) {}
    }
  }
}

// Recommend and Want to watch. One write runs at a time, and a failure shows
// beneath the buttons. Taking a top 10 title's Recommend away, or switching
// it to Want to watch, asks first.
private struct ShareTitleActions: View {
  let model: ShareTitleModel
  let header: TitleHeader

  var body: some View {
    let actions = model.actions
    Button {
      Task { await actions.toggleRecommend(header) }
    } label: {
      Label(header.recommendLabel, systemImage: header.recommended ? "checkmark" : "plus")
    }
    .accessibilityAddTraits(header.recommended ? .isSelected : [])
    .disabled(actions.write == .saving)
    Button {
      Task { await model.toggleWantToWatch(header) }
    } label: {
      Label(
        model.wantToWatch ? "In Want to watch" : "Want to watch",
        systemImage: model.wantToWatch ? "checkmark" : "plus"
      )
    }
    .accessibilityAddTraits(model.wantToWatch ? .isSelected : [])
    .accessibilityHint(model.wantToWatch ? "Removes it from Want to watch." : "")
    .disabled(actions.write == .saving)
    if let status = header.status, status != .wantToWatch {
      Text("Your status: \(status.label)")
        .font(.subheadline)
    }
    if let failure = actions.failure?.message {
      Label(failure, systemImage: "exclamationmark.triangle")
        .font(.subheadline)
    }
  }
}
