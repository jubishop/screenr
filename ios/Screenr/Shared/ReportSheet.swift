import ScreenrKit
import SwiftUI

extension View {
  // The report form and, once it closes after a report, the offer to block
  // the author. A screen presents them outside its content, so a failed read
  // beneath leaves them open.
  func reporting(_ reports: ReportModel) -> some View {
    modifier(ReportPresentation(reports: reports))
  }
}

private struct ReportPresentation: ViewModifier {
  @Bindable var reports: ReportModel

  func body(content: Content) -> some View {
    content
      .keyboardSafeSheet(item: $reports.form) { subject in
        ReportSheet(subject: subject, model: reports)
      }
      .alert(
        prompt?.title ?? "",
        isPresented: Binding(
          get: { prompt != nil },
          set: { if !$0 { reports.dismissPrompt() } }
        ),
        presenting: prompt
      ) { prompt in
        switch prompt {
        case .offer(let subject):
          Button(subject.blockLabel, role: .destructive) {
            Task { await reports.block(subject) }
          }
          Button("Not Now", role: .cancel) { reports.dismissPrompt() }
        case .blockFailed:
          Button("OK", role: .cancel) { reports.dismissPrompt() }
        }
      } message: { prompt in
        Text(prompt.message)
      }
  }

  // Read while rendering, so a new prompt renders the alert.
  private var prompt: ReportModel.Prompt? { reports.prompt }
}

// The report form: why, from the six reasons, with an optional note, and
// what happens next. Report needs a reason. A failure shows the server's
// words here and keeps the form, which can't close while the report sends.
struct ReportSheet: View {
  let subject: ReportSubject
  let model: ReportModel

  private var sending: Bool { model.phase == .sending }

  var body: some View {
    NavigationStack {
      Form {
        if case .failed(let message) = model.phase {
          Section {
            FailureLabel(message)
          }
        }
        Section {
          ForEach(ReportReason.allCases) { reason in
            Button {
              model.choose(reason)
            } label: {
              HStack {
                Text(reason.label)
                  .foregroundStyle(Color.primary)
                Spacer()
                if model.reason == reason {
                  Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
                }
              }
              .contentShape(Rectangle())
            }
          }
        } header: {
          SectionHeading("Why are you reporting it?")
        }
        Section {
          TextField(
            "Add details (optional)",
            text: Binding(get: { model.note }, set: { model.setNote($0) }),
            axis: .vertical
          )
          .lineLimit(3...8)
        }
      }
      .disabled(sending)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        FormNoteBar {
          Text(subject.notice)
        }
      }
      .navigationTitle(subject.title)
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark", role: .cancel) { model.cancel() }
            .disabled(sending)
        }
        ToolbarItem(placement: .confirmationAction) {
          if sending {
            ProgressView()
          } else {
            Button("Report", systemImage: "flag", role: .confirm) {
              Task { await model.send() }
            }
            .disabled(!model.canSend)
          }
        }
      }
      .interactiveDismissDisabled(sending)
    }
    .onDisappear { model.formClosed() }
  }
}
