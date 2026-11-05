"""Check that the iPhone app presents sheets only through .keyboardSafeSheet(item:content:).

When a sheet closes, UIKit brings back the keyboard of a field that was editing
as it opened, and that can deadlock SwiftUI. The modifier ends editing before a
sheet opens. A plain .sheet, .fullScreenCover, or .popover would bring the
keyboard back, and the hang it risks is silent and intermittent. See the
keyboard deadlock in ios/README.md#toolchain-notes.
"""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
# The app's and its extensions' sources; ScreenrKit holds no views.
SOURCES = ("ios/Screenr", "ios/ScreenrShare", "ios/ScreenrNotificationService")
MODIFIER = Path("ios/Screenr/Shared/KeyboardSafeSheet.swift")
PRESENTATION = re.compile(r"\.(sheet|fullScreenCover|popover)\(")


def presentations(root):
    """Each source line, outside the modifier and comments, that presents a sheet, cover, or popover."""
    found = []
    for directory in SOURCES:
        for path in sorted((root / directory).rglob("*.swift")):
            relative = path.relative_to(root)
            if relative == MODIFIER:
                continue
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if not line.lstrip().startswith("//") and PRESENTATION.search(line):
                    found.append(f"{relative}:{number}: {line.strip()}")
    return found


class IOSSheetTests(unittest.TestCase):
    def test_only_the_keyboard_safe_modifier_presents_sheets(self):
        self.assertEqual([], presentations(ROOT),
                         "Present sheets with .keyboardSafeSheet(item:content:), never .sheet, "
                         ".fullScreenCover, or .popover, so closing one never brings back a keyboard; "
                         "see ios/README.md#toolchain-notes.")

    def test_the_check_reads_the_modifier_it_exempts(self):
        # A moved modifier would leave this check passing without reading anything.
        self.assertRegex((ROOT / MODIFIER).read_text(), PRESENTATION)


if __name__ == "__main__":
    unittest.main()
