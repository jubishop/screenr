import SwiftUI

// Lays its views out in a row that wraps onto more lines as needed, such as
// an entry's actions and reaction counts at large text sizes.
struct FlowLayout: Layout {
  var spacing: CGFloat = 8
  var lineSpacing: CGFloat = 4

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let lines = arrange(subviews, width: proposal.width ?? .infinity)
    let width = lines.map(\.width).max() ?? 0
    let height = lines.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(lines.count - 1, 0))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) {
    var y = bounds.minY
    for line in arrange(subviews, width: bounds.width) {
      var x = bounds.minX
      for item in line.items {
        let size = item.size
        subviews[item.index]
          .place(
            at: CGPoint(x: x, y: y + (line.height - size.height) / 2),
            proposal: ProposedViewSize(size)
          )
        x += size.width + spacing
      }
      y += line.height + lineSpacing
    }
  }

  private struct Line {
    var items: [(index: Int, size: CGSize)] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  // Each view at its ideal size, no wider than a line, in lines that fit.
  private func arrange(_ subviews: Subviews, width: CGFloat) -> [Line] {
    var lines: [Line] = []
    var line = Line()
    for index in subviews.indices {
      var size = subviews[index].sizeThatFits(.unspecified)
      if size.width > width {
        size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
      }
      let needed = line.items.isEmpty ? size.width : line.width + spacing + size.width
      if !line.items.isEmpty, needed > width {
        lines.append(line)
        line = Line()
      }
      line.width = line.items.isEmpty ? size.width : line.width + spacing + size.width
      line.height = max(line.height, size.height)
      line.items.append((index, size))
    }
    if !line.items.isEmpty { lines.append(line) }
    return lines
  }
}
