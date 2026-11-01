import ScreenrKit
import SwiftUI

// What `AuditProbe` shows: text that fails the audit's contrast and clipped
// text checks, in the middle of the screen, where no bar covers it.
struct AuditProbeView: View {
  let probe: AuditProbe

  var body: some View {
    switch probe {
    case .faintClippedText:
      Text("Audit probe: faint text cut off at its width")
        .foregroundStyle(Color(white: 0.85))
        .lineLimit(1)
        .frame(width: 120)
        .padding(8)
        .background(Color.white)
        .allowsHitTesting(false)
    }
  }
}
