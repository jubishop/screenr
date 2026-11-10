import ScreenrKit
import SwiftUI

// The app's first screen at each launch, while the age check runs. Where the
// law requires the check, Apple's sheet asking the person to share their age
// range can show over it, so the check waits until the app is first active,
// not launched in the background, and goes on if the sheet makes it inactive.
struct AgeCheckView: View {
  @Environment(AgeCheck.self) private var ageCheck
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasActive = false

  var body: some View {
    ProgressView()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .onChange(of: scenePhase, initial: true) { _, phase in
        if phase == .active { wasActive = true }
      }
      .task(id: wasActive) {
        if wasActive { await ageCheck.check(using: SystemAgeAssurance()) }
      }
  }
}

// Shown in place of the app when the age check refuses the person. A minor
// gets no way in. Someone who declined to share, or whose check failed, can
// check again.
struct AdultsOnlyView: View {
  let refusal: AgeCheck.Refusal
  @Environment(AgeCheck.self) private var ageCheck

  var body: some View {
    MessageView(title: "Screenr is for adults", systemImage: "hand.raised", message: message) {
      if refusal != .minor {
        Button("Try again") {
          ageCheck.retry()
        }
        .buttonStyle(.bordered)
      }
    }
    .background(Color(uiColor: .systemBackground))
  }

  private var message: String {
    switch refusal {
    case .minor:
      "You must be 18 or older to use Screenr."
    case .declined:
      "You must be 18 or older to use Screenr, and where you live, the law requires it to check your age range with Apple. Share your age range in Settings → your name → Personal Information → Age Range for Apps, then try again."
    case .failed:
      "You must be 18 or older to use Screenr, and it couldn’t check your age range with Apple. Try again in a moment."
    }
  }
}
