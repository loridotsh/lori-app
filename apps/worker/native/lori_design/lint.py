"""Checks a workbook for the mistakes that make a deliverable look broken, before the member sees it.

    python -m lori_design.lint budget.xlsx

It reads any .xlsx (built with this kit, openpyxl or anything else) and prints one line per problem:
text that cannot be seen (white on white), filled rows with nothing in them, formulas that carry no
stored result, numbers too wide for their column, and code-style column titles. Fix every line it
prints, rebuild, and run it again until it says "No problems found".
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

__all__ = ["lint_workbook", "main"]

NEAR_WHITE = 0xE8


def _rgb(color) -> tuple[int, int, int] | None:
    """An openpyxl colour as RGB, or None when it is automatic, indexed or a theme colour other than black/white."""
    if color is None:
        return None
    value = getattr(color, "rgb", None)
    if isinstance(value, str) and len(value) in (6, 8):
        try:
            return int(value[-6:-4], 16), int(value[-4:-2], 16), int(value[-2:], 16)
        except ValueError:
            return None
    theme = getattr(color, "theme", None)
    if isinstance(theme, int) and theme in (0, 1):
        # Theme 0 is the window colour (white) and 1 is the text colour (black) in every standard theme.
        return (255, 255, 255) if theme == 0 else (0, 0, 0)
    return None


def _luminance(rgb: tuple[int, int, int]) -> float:
    def channel(v: int) -> float:
        s = v / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    x, y = _luminance(a), _luminance(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def _fill(cell) -> tuple[int, int, int] | None:
    fill = cell.fill
    if fill is None or fill.fill_type != "solid":
        return None
    return _rgb(fill.fgColor)


def _table_covering(sheet, cell):
    for table in sheet.tables.values():
        try:
            first, last = table.ref.split(":")
        except ValueError:
            continue
        from openpyxl.utils.cell import coordinate_from_string, column_index_from_string

        c1, r1 = coordinate_from_string(first)
        c2, r2 = coordinate_from_string(last)
        if r1 <= cell.row <= r2 and column_index_from_string(c1) <= cell.column <= column_index_from_string(c2):
            return table, r1
    return None, None


def lint_workbook(path: str | Path) -> list[str]:
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter

    problems: list[str] = []
    workbook = load_workbook(path)
    cached = load_workbook(path, data_only=True)
    for sheet in workbook.worksheets:
        name = sheet.title
        values = cached[name]
        missing: list[str] = []
        invisible: list[str] = []
        for row in sheet.iter_rows():
            for cell in row:
                value = cell.value
                has_content = value is not None and value != ""
                if has_content:
                    table, header_row = _table_covering(sheet, cell)
                    # A table's own style fills its header; elsewhere the cell must carry its own background.
                    styled_by_table = table is not None and cell.row == header_row and (table.tableStyleInfo is not None and table.tableStyleInfo.name)
                    text = _rgb(cell.font.color) if cell.font is not None else None
                    background = _fill(cell) or (None if styled_by_table else (255, 255, 255))
                    if text is not None and background is not None and _contrast(text, background) < 1.6:
                        invisible.append(cell.coordinate)
                if isinstance(value, str) and value.startswith("=") and values[cell.coordinate].value is None:
                    missing.append(cell.coordinate)
        if invisible:
            shown = ", ".join(invisible[:4]) + (f" and {len(invisible) - 4} more" if len(invisible) > 4 else "")
            problems.append(f"{name}!{shown}: the text colour matches the background (for example white text with no fill), so it cannot be read. Give the cells a dark fill or a dark text colour; do not rely on a table style to supply it.")
        if missing:
            shown = ", ".join(missing[:4]) + (f" and {len(missing) - 4} more" if len(missing) > 4 else "")
            problems.append(f"{name}!{shown}: formulas carry no stored result, so previews and other readers show them blank. Build with lori_design.xlsx_kit, or run recalculate_spreadsheet.")
        # Rows that are coloured but empty: usually a fill applied to the wrong row.
        for row in sheet.iter_rows():
            filled = [c for c in row if _fill(c) is not None]
            if len(filled) >= 2 and all(c.value in (None, "") for c in row) and not any(_table_covering(sheet, c)[0] for c in filled):
                problems.append(f"{name}!row {row[0].row}: a coloured row with nothing in it. If a header or total was meant to be coloured, it is probably a different row.")
        # Code-style titles in the first row of a block.
        for cell in next(iter(sheet.iter_rows(min_row=1, max_row=1)), []):
            if isinstance(cell.value, str) and "_" in cell.value and " " not in cell.value:
                problems.append(f"{name}!{cell.coordinate}: the title '{cell.value}' looks like a code name. Use a readable title such as '{cell.value.replace('_', ' ').capitalize()}'.")
        # Numbers wider than their column show as ####.
        narrow: dict[str, str] = {}
        for row in sheet.iter_rows():
            for cell in row:
                shown = values[cell.coordinate].value
                if isinstance(shown, (int, float)) and not isinstance(shown, bool):
                    width = sheet.column_dimensions[get_column_letter(cell.column)].width or 8.43
                    code = str(cell.number_format).split(";")[0]
                    if code == "General":
                        text = f"{shown:g}"
                    else:
                        decimals = len(re.findall(r"[0#?]", code.split(".", 1)[1])) if "." in code else 0
                        text = f"{abs(shown) * (100 if '%' in code else 1):,.{decimals}f}"
                    length = len(text) + sum(1 for symbol in "$%€£" if symbol in code) + (1 if shown < 0 else 0)
                    if length + 0.5 > width and get_column_letter(cell.column) not in narrow:
                        narrow[get_column_letter(cell.column)] = cell.coordinate
        for column, coordinate in narrow.items():
            problems.append(f"{name}!column {column}: too narrow for its numbers (see {coordinate}); they would show as ####. Widen the column.")
    return problems


def main(argv: list[str] | None = None) -> int:
    paths = argv if argv is not None else sys.argv[1:]
    if not paths:
        print("usage: python -m lori_design.lint file.xlsx [...]")
        return 2
    total = 0
    for path in paths:
        if not str(path).lower().endswith(".xlsx"):
            print(f"{path}: no checks for this kind of file")
            continue
        problems = lint_workbook(path)
        total += len(problems)
        for problem in problems:
            print(f"{path}: {problem}")
    print("No problems found." if not total else f"{total} problem{'s' if total != 1 else ''} to fix.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
