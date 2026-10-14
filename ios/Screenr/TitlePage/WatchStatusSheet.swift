import ScreenrKit
import SwiftUI

// The status button's choices: Want to watch, Watching, Caught up for TV,
// Finished, and Stopped watching, with the current one checked, and Clear
// status. Choosing one closes the sheet and saves it; Finished records today.
// While a progress status or a stored date exists, Last finished changes or
// clears the date. Switching a top 10 title to Want to watch asks here first.
struct WatchStatusSheet: View {
  let header: TitleHeader
  let model: TitlePageModel
  @State private var date: Date

  init(header: TitleHeader, model: TitlePageModel) {
    self.header = header
    self.model = model
    var start = Date.now
    if let finishedOn = header.finishedOn, let stored = CalendarDay.date(from: finishedOn) {
      start = stored
    }
    _date = State(initialValue: start)
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(header.statusOptions, id: \.self) { status in
            choice(status.label, chosen: status == header.status) { choose(status) }
              .accessibilityIdentifier("status-\(status.rawValue)")
          }
          if header.status != nil {
            choice("Clear status", chosen: false) { choose(nil) }
          }
        }
        if let leaving = model.leaving, case .switchToWantToWatch = leaving {
          Section {
            Text(leaving.message)
            Button(role: .destructive) {
              Task { await model.confirm(leaving, for: header) }
            } label: {
              row(leaving.action)
                .foregroundStyle(.danger)
            }
            Button {
              model.leaving = nil
            } label: {
              row("Cancel")
            }
          }
        }
        if header.showsFinishedDate {
          Section {
            DatePicker(
              "Last finished",
              selection: $date,
              in: earliest...Date.now,
              displayedComponents: .date
            )
            // Save date shows once the chosen day differs from the stored one.
            if CalendarDay.string(from: date) != header.finishedOn {
              Button {
                Task { await model.saveFinishedDate(CalendarDay.string(from: date), for: header) }
              } label: {
                row("Save date")
              }
            }
            if header.finishedOn != nil {
              Button {
                Task { await model.saveFinishedDate(nil, for: header) }
              } label: {
                row("Clear date")
              }
            }
          }
        }
      }
      .disabled(model.write == .saving)
      .navigationTitle("Watch status")
      .toolbarTitleDisplayMode(.inline)
      .toolbar { CloseButton() }
    }
  }

  private var earliest: Date {
    CalendarDay.date(from: CalendarDay.earliest) ?? .distantPast
  }

  private func choose(_ status: WatchStatus?) {
    Task { await model.choose(status, for: header, today: CalendarDay.today()) }
  }

  private func choice(_ label: String, chosen: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        Text(label)
        Spacer()
        if chosen {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(Rectangle())
    }
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }

  // A row's label as text that follows Dynamic Type, which a plain titled
  // button in a list did not for the accessibility audit.
  private func row(_ label: String) -> some View {
    Text(label)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
  }
}
