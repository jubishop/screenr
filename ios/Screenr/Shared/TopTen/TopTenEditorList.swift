import ScreenrKit
import SwiftUI
import UIKit

// The top 10 editor's system list, from UIKit, since SwiftUI's List shows
// reorder handles only in edit mode, where rows do not swipe. Every row shows
// its handle and swipes to remove, and its content is a SwiftUI view. The
// rows follow the editor's entries: a drop or a removal shows at once, and a
// failed save puts the rows back.
struct TopTenEditorList: UIViewRepresentable {
  let editor: TopTenEditorModel
  // The editor's state, read here so the list updates when it changes.
  let entries: [TopTenEntry]
  let failure: String?
  let write: TopTenEditorModel.Write
  @Environment(\.imageSource) private var images

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> UICollectionView {
    context.coordinator.makeList()
  }

  func updateUIView(_ list: UICollectionView, context: Context) {
    context.coordinator.show(self)
  }

  final class Coordinator: NSObject, UICollectionViewDelegate {
    nonisolated enum Section: Hashable, Sendable {
      case failure
      case entries
    }

    nonisolated enum Row: Hashable, Sendable {
      case failure(String)
      // A top 10 entry, by title ID.
      case entry(String)
      // The list is empty.
      case empty
    }

    private var shown: TopTenEditorList?
    private var dataSource: UICollectionViewDiffableDataSource<Section, Row>?
    // The entry the latest drag picked up.
    private var dragged: String?

    func makeList() -> UICollectionView {
      let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
        var configuration = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
        let section = self?.dataSource?.sectionIdentifier(for: index)
        configuration.footerMode = section == .entries ? .supplementary : .none
        configuration.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
          self?.removal(at: indexPath)
        }
        return NSCollectionLayoutSection.list(using: configuration, layoutEnvironment: environment)
      }
      let list = UICollectionView(frame: .zero, collectionViewLayout: layout)
      list.delegate = self
      let entryCell = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
        [weak self] cell, _, id in
        guard let shown = self?.shown, let entry = shown.entries.first(where: { $0.id == id })
        else { return }
        cell.contentConfiguration = UIHostingConfiguration {
          TopTenEditorRow(entry: entry, count: shown.entries.count) { rank in
            shown.editor.move(entry, toRank: rank)
          }
          .environment(\.imageSource, shown.images)
        }
        cell.accessories = [.reorder(displayed: .always)]
      }
      let noteCell = UICollectionView.CellRegistration(handler: Self.showNote)
      let footer = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
        elementKind: UICollectionView.elementKindSectionFooter
      ) { view, _, _ in
        view.contentConfiguration = UIHostingConfiguration {
          Text(
            "Drag a title by its handle to change its rank. Swipe left to remove it; it stays recommended."
          )
          .font(.footnote)
          .foregroundStyle(.muted)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      let dataSource = UICollectionViewDiffableDataSource<Section, Row>(
        collectionView: list
      ) { list, indexPath, row in
        if case .entry(let id) = row {
          return list.dequeueConfiguredReusableCell(using: entryCell, for: indexPath, item: id)
        }
        return list.dequeueConfiguredReusableCell(using: noteCell, for: indexPath, item: row)
      }
      dataSource.supplementaryViewProvider = { list, _, indexPath in
        list.dequeueConfiguredReusableSupplementary(using: footer, for: indexPath)
      }
      dataSource.reorderingHandlers.canReorderItem = { [weak self] row in
        guard case .entry = row else { return false }
        return self?.shown?.write == .idle
      }
      dataSource.reorderingHandlers.didReorder = { [weak self] transaction in
        self?.dropped(transaction)
      }
      self.dataSource = dataSource
      return list
    }

    // Shows the editor's entries and failure, moving, adding, and removing
    // rows to match.
    func show(_ list: TopTenEditorList) {
      let previous = shown?.entries
      shown = list
      guard let dataSource else { return }
      var snapshot = NSDiffableDataSourceSnapshot<Section, Row>()
      if let failure = list.failure {
        snapshot.appendSections([.failure])
        snapshot.appendItems([.failure(failure)], toSection: .failure)
      }
      snapshot.appendSections([.entries])
      snapshot.appendItems(
        list.entries.isEmpty ? [.empty] : list.entries.map { .entry($0.id) },
        toSection: .entries
      )
      // Rows that stay show their new rank and move actions.
      let kept = list.entries.filter { entry in
        previous?.contains { $0.id == entry.id } ?? false
      }
      snapshot.reconfigureItems(kept.map { .entry($0.id) })
      dataSource.apply(snapshot, animatingDifferences: previous != nil)
    }

    // Saves the dropped order. When nothing saves, such as for a drop in
    // place, the rows return to the editor's order once the drop finishes.
    private func dropped(_ transaction: NSDiffableDataSourceTransaction<Section, Row>) {
      let order = transaction.finalSnapshot.itemIdentifiers(inSection: .entries)
        .compactMap { row -> String? in
          guard case .entry(let id) = row else { return nil }
          return id
        }
      let picked = dragged
      dragged = nil
      guard let shown, shown.editor.drop(order, dragged: picked) == nil else { return }
      Task { show(shown) }
    }

    // Swiping a row offers Remove while no change is saving.
    private func removal(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
      guard let shown, shown.write == .idle,
        case .entry(let id)? = dataSource?.itemIdentifier(for: indexPath),
        let entry = shown.entries.first(where: { $0.id == id })
      else { return nil }
      let remove = UIContextualAction(style: .destructive, title: "Remove") { _, _, done in
        shown.editor.remove(entry)
        done(true)
      }
      // The system's red falls short of 4.5:1 contrast with the white title.
      remove.backgroundColor = UIColor(red: 0.72, green: 0.09, blue: 0.09, alpha: 1)
      return UISwipeActionsConfiguration(actions: [remove])
    }

    // A drag stays among the entries, and remembers which entry it picked up.
    func collectionView(
      _ collectionView: UICollectionView,
      targetIndexPathForMoveOfItemFromOriginalIndexPath original: IndexPath,
      atCurrentIndexPath current: IndexPath,
      toProposedIndexPath proposed: IndexPath
    ) -> IndexPath {
      if case .entry(let id)? = dataSource?.itemIdentifier(for: original) { dragged = id }
      guard let section = dataSource?.snapshot().indexOfSection(.entries) else { return current }
      if proposed.section < section { return IndexPath(item: 0, section: section) }
      if proposed.section > section {
        let count = collectionView.numberOfItems(inSection: section)
        return IndexPath(item: max(count - 1, 0), section: section)
      }
      return proposed
    }

    func collectionView(
      _ collectionView: UICollectionView,
      shouldHighlightItemAt indexPath: IndexPath
    ) -> Bool {
      false
    }

    // A row that is not an entry: the failure or the empty list's note.
    private static func showNote(
      in cell: UICollectionViewListCell,
      at indexPath: IndexPath,
      _ row: Row
    ) {
      cell.contentConfiguration = UIHostingConfiguration {
        switch row {
        case .failure(let message):
          FailureLabel(message)
        case .empty:
          Text("Rank up to 10 titles you recommend. Choose Add to top 10 on a title page to start.")
            .foregroundStyle(.muted)
        case .entry:
          EmptyView()
        }
      }
    }
  }
}
