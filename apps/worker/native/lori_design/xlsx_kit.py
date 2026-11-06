"""Workbooks that look designed: typed values, frozen headers, no gridlines, native charts.

    from lori_design.xlsx_kit import Book
    book = Book("sales.xlsx", title="Q3 sales")
    data = book.sheet("EMEA")
    data.title("EMEA sales", "20 illustrative transactions, USD")
    table = data.table(["Customer", "Units", "Unit price", "Total"], rows,
                       formats=["text", "int", "money2", "money"], total_row=True,
                       formulas={3: "=B{r}*C{r}"})
    summary = book.sheet("Summary", first=True)
    summary.title("Summary")
    summary.table(["Region", "Sales"], [["EMEA", book.ref("EMEA", table.total_cell(3))]], formats=["text", "money"])
    book.close()

Built on XlsxWriter. Values are real numbers and dates (never strings that look like
them). Whenever a formula's result is known, its value is stored with it, so every
reader shows numbers, not zeros, before Excel recalculates.
"""
from __future__ import annotations

import datetime as _dt
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import xlsxwriter
from xlsxwriter.utility import xl_col_to_name, xl_range_abs, xl_rowcol_to_cell

from .formulas import Formulas
from .theme import DEFAULT, HAIR, INK, MUTED, NEGATIVE, RULE, SURFACE, TEXT, WHITE, Theme, on_color, tint

__all__ = ["Book", "Sheet", "TableRef", "FORMATS", "a1", "col_name"]

# name -> (Excel number format, alignment)
FORMATS: dict[str, tuple[str | None, str]] = {
    "text": (None, "left"),
    "int": ("#,##0;(#,##0);\"-\"", "right"),
    "num1": ("#,##0.0;(#,##0.0);\"-\"", "right"),
    "num2": ("#,##0.00;(#,##0.00);\"-\"", "right"),
    "money": ("$#,##0;($#,##0);\"-\"", "right"),
    "money2": ("$#,##0.00;($#,##0.00);\"-\"", "right"),
    "pct": ("0.0%;(0.0%);\"-\"", "right"),
    "pct0": ("0%;(0%);\"-\"", "right"),
    "date": ("yyyy-mm-dd", "left"),
    "month": ("mmm yyyy", "left"),
    "multiple": ("0.0\"x\"", "right"),
}
_NUMERIC = {"int", "num1", "num2", "money", "money2", "pct", "pct0", "multiple"}


def col_name(index: int) -> str:
    return xl_col_to_name(index)


def a1(row: int, col: int, absolute: bool = False) -> str:
    """Zero-based (row, col) to 'B3' (or '$B$3')."""
    return xl_rowcol_to_cell(row, col, row_abs=absolute, col_abs=absolute)


@dataclass
class TableRef:
    """Where a table landed, for charts and formulas that point at it."""

    sheet: str
    header_row: int       # zero-based
    first_row: int
    last_row: int
    first_col: int
    columns: list[str]
    total_row: int | None = None

    def col(self, index: int) -> int:
        return self.first_col + index

    def range(self, index: int, absolute: bool = True) -> str:
        c = self.col(index)
        return f"{_quote(self.sheet)}!{xl_range_abs(self.first_row, c, self.last_row, c) if absolute else a1(self.first_row, c) + ':' + a1(self.last_row, c)}"

    def header(self, index: int) -> str:
        return f"{_quote(self.sheet)}!{a1(self.header_row, self.col(index), True)}"

    def total_cell(self, index: int) -> str:
        if self.total_row is None:
            raise ValueError("This table has no total row")
        return a1(self.total_row, self.col(index))


def _quote(name: str) -> str:
    return f"'{name}'" if re.search(r"[^A-Za-z0-9_]", name) else name


def _display_width(value: Any, kind: str) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)) and kind in FORMATS and kind != "text":
        decimals = 2 if kind in ("num2", "money2") else 1 if kind in ("num1", "pct") else 0
        text = f"{abs(value):,.{decimals}f}" + ("%" if kind.startswith("pct") else "") + ("$" if kind.startswith("money") else "")
        return len(text) + 2
    if isinstance(value, (_dt.date, _dt.datetime)):
        return 11
    text = str(value)
    return max((len(line) for line in text.split("\n")), default=0)


class Book:
    def __init__(self, path: str, theme: Theme = DEFAULT, title: str | None = None, author: str | None = None):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.theme = theme
        self.wb = xlsxwriter.Workbook(path, {"nan_inf_to_errors": True})
        self.wb.formats[0].set_font_name(theme.font)
        self.wb.formats[0].set_font_size(10)
        self.wb.set_properties({"title": title or "", "author": author or "Lori", "comments": ""})
        self.wb.set_calc_mode("auto")
        self._formats: dict[tuple, Any] = {}
        self.sheets: dict[str, Sheet] = {}
        self._order: list[str] = []
        # Every value the kit writes, by (sheet, row, col), so formulas get real cached results.
        self.values: dict[tuple[str, int, int], Any] = {}
        self.engine = Formulas(self.values)

    # -------- formats
    def fmt(self, **props: Any):
        """A cell format with the workbook's font and these properties (cached)."""
        base = {"font_name": self.theme.font, "font_size": 10, "font_color": f"#{TEXT}", "valign": "vcenter"}
        base.update({k: v for k, v in props.items()})
        key = tuple(sorted(base.items(), key=lambda kv: kv[0]))
        if key not in self._formats:
            self._formats[key] = self.wb.add_format(base)
        return self._formats[key]

    # -------- sheets
    def sheet(self, name: str, tab_color: str | None = None, landscape: bool = True,
              gridlines: bool = False, first: bool = False, gutter: bool = True) -> "Sheet":
        """Add a worksheet (name <= 31 characters). first=True makes it the first tab, and the one the workbook opens on.

        Build the sheets other sheets point at first (so their totals are known), then the summary with
        first=True: the tab order in the file is still summary first.
        """
        if len(name) > 31 or re.search(r"[\[\]:*?/\\]", name):
            raise ValueError("Sheet names are at most 31 characters and cannot contain [ ] : * ? / \\")
        sheet = Sheet(self, self.wb.add_worksheet(name), name, tab_color, landscape, gridlines, gutter)
        self.sheets[name] = sheet
        self._order.append(name)
        if first:
            sheet.ws.activate()
            sheet.ws.set_first_sheet()
            self._first = name
        return sheet

    def ref(self, sheet: str, cell: str) -> str:
        """A formula reference to another sheet's cell, e.g. =EMEA!B24."""
        return f"={_quote(sheet)}!{cell}"

    def close(self) -> str:
        self._move_first_sheet_to_front()
        self.wb.close()
        return self.path

    def _move_first_sheet_to_front(self) -> None:
        """XlsxWriter keeps sheets in the order they were added; a summary built last still belongs in front."""
        name = getattr(self, "_first", None)
        sheets = self.wb.worksheets_objs
        if name is None or not sheets or sheets[0] is self.sheets[name].ws:
            return
        target = self.sheets[name].ws
        sheets.remove(target)
        sheets.insert(0, target)
        # Print titles, filters and the opening tab refer to sheets by position.
        for position, worksheet in enumerate(sheets):
            worksheet.index = position
        self.wb.worksheet_meta.activesheet = 0
        self.wb.worksheet_meta.firstsheet = 0


class Sheet:
    def __init__(self, book: Book, ws, name: str, tab_color: str | None, landscape: bool, gridlines: bool, gutter: bool):
        self.book, self.ws, self.name = book, ws, name
        self.theme = book.theme
        self.row = 1                      # next free row (zero-based); row 0 is breathing room
        self.col0 = 1 if gutter else 0    # first content column
        if tab_color:
            ws.set_tab_color(f"#{tab_color}")
        if not gridlines:
            ws.hide_gridlines(2)
        if gutter:
            ws.set_column(0, 0, 2)
        if landscape:
            ws.set_landscape()
        ws.set_paper(1)
        ws.fit_to_pages(1, 0)
        ws.set_margins(left=0.6, right=0.6, top=0.7, bottom=0.7)
        ws.set_footer("&L&8&A&R&8Page &P of &N")
        self._widths: dict[int, float] = {}

    # ------------------------------------------------------------ text
    def title(self, text: str, subtitle: str | None = None) -> None:
        """A modest title (14pt, unfilled) with an optional muted line under it."""
        b = self.book
        self.ws.set_row(self.row, 24)
        self.ws.write(self.row, self.col0, text, b.fmt(font_size=14, bold=True, font_color=f"#{INK}"))
        self.row += 1
        if subtitle:
            self.ws.write(self.row, self.col0, subtitle, b.fmt(font_size=9, font_color=f"#{MUTED}"))
            self.row += 1
        self.row += 1

    def heading(self, text: str) -> None:
        """A section heading with a thin rule beneath it."""
        b = self.book
        self.ws.write(self.row, self.col0, text, b.fmt(font_size=11, bold=True, font_color=f"#{INK}", bottom=1, bottom_color=f"#{RULE}"))
        self.row += 1

    def note(self, text: str, row: int | None = None, col: int | None = None) -> None:
        """A muted italic note. Notes sit in ordinary cells (no wrapping, no merging)."""
        r = self.row if row is None else row
        self.ws.write(r, self.col0 if col is None else col, text, self.book.fmt(font_size=9, italic=True, font_color=f"#{MUTED}"))
        if row is None:
            self.row += 1

    def skip(self, rows: int = 1) -> None:
        self.row += rows

    # ----------------------------------------------------------- tables
    def table(
        self,
        headers: Sequence[str],
        rows: Sequence[Sequence[Any]],
        formats: Sequence[str] | None = None,
        widths: Sequence[float] | None = None,
        formulas: dict[int, str] | None = None,
        total_row: bool | Sequence[str] = False,
        freeze: bool | None = None,
        filter: bool = True,
        wrap: Sequence[int] = (),
        start_col: int | None = None,
        input_cols: Sequence[int] = (),
    ) -> TableRef:
        """Write a data table and return where it is.

        formats: one name per column (text, int, num1, num2, money, money2, pct, pct0, date, month,
                 multiple) or a raw Excel number format. Defaults are guessed from the values.
        formulas: {column_index: "={Units}*{Unit price}"} per row. {Header name} becomes that column's
                  cell in the same row, so you never write column letters; {r} is the row number.
                  The result is calculated and stored with the formula (arithmetic, references to
                  any sheet written earlier, SUM/AVERAGE/MIN/MAX/COUNT/ROUND/IF); for anything
                  else pass the value in `rows`, or it is stored as 0 until recalculated.
        total_row: True sums every numeric column; or a list like ["Total", "sum", "sum", "avg"]
                   with one entry per column (a label, sum, avg, min, max, count or "").
        freeze: keep the header visible while scrolling. None (the default) does it for tables of 12 or
                more rows, once per sheet; pass True or False to decide yourself.
        wrap: column indexes whose text wraps (long descriptions).
        input_cols: columns the member is expected to edit: blue text on a light fill.
        """
        b = self.book
        ws = self.ws
        c0 = self.col0 if start_col is None else start_col
        header_row = self.row
        n = len(headers)
        kinds = list(formats) if formats else [_guess_kind(rows, i) for i in range(n)]
        kinds += ["text"] * (n - len(kinds))
        header_fill = f"#{self.theme.accent}"
        header_color = f"#{on_color(self.theme.accent)}"
        ws.set_row(header_row, 22)
        for i, text in enumerate(headers):
            align = "right" if _is_numeric_kind(kinds[i]) else "left"
            ws.write(header_row, c0 + i, text, b.fmt(bold=True, bg_color=header_fill, font_color=header_color, align=align,
                                                     text_wrap=True, left=1 if i else 0, left_color=header_color if False else header_fill))
        first = header_row + 1
        formula_cols = formulas or {}
        computed: dict[tuple[int, int], Any] = {}
        letters = {str(h): col_name(c0 + j) for j, h in enumerate(headers)}
        engine = b.engine

        def resolve(template: str, excel_row: int) -> str:
            """{Units} -> E5 (this row), {r} -> the row number. Unknown names are left alone."""
            def sub(match: re.Match) -> str:
                key = match.group(1)
                if key == "r":
                    return str(excel_row)
                return f"{letters[key]}{excel_row}" if key in letters else match.group(0)
            return re.sub(r"\{([^{}]+)\}", sub, template)

        for r_index, row in enumerate(rows):
            excel_row = first + r_index + 1  # 1-based row number for formulas
            # Plain values first, so a formula can use any column of its own row.
            for i in range(n):
                if i in formula_cols:
                    continue
                value = row[i] if i < len(row) else None
                self._write_value(first + r_index, c0 + i, value, self._body_format(kinds[i], i in wrap, i in input_cols, last=False), kinds[i])
                computed[(first + r_index, i)] = b.values.get((self.name, first + r_index, c0 + i), value)
            for i in sorted(formula_cols):
                value = row[i] if i < len(row) else None
                fmt = self._body_format(kinds[i], i in wrap, i in input_cols, last=False)
                formula = resolve(formula_cols[i], excel_row)
                result = value if value is not None else engine.evaluate(formula, self.name)
                ws.write_formula(first + r_index, c0 + i, formula, fmt, result if result is not None else 0)
                b.values[(self.name, first + r_index, c0 + i)] = result if result is not None else 0
                computed[(first + r_index, i)] = result
        last = first + len(rows) - 1
        total_index: int | None = None
        if total_row and rows:
            total_index = last + 1
            spec = list(total_row) if not isinstance(total_row, bool) else [
                "Total" if j == 0 else ("sum" if _is_numeric_kind(kinds[j]) else "") for j in range(n)]
            ws.set_row(total_index, 20)
            for i in range(n):
                label = spec[i] if i < len(spec) else ""
                fmt = self._total_format(kinds[i])
                column = f"{col_name(c0 + i)}{first + 1}:{col_name(c0 + i)}{last + 1}"
                if label in ("sum", "avg", "min", "max", "count"):
                    func = {"sum": "SUM", "avg": "AVERAGE", "min": "MIN", "max": "MAX", "count": "COUNT"}[label]
                    values = [computed.get((first + k, i)) for k in range(len(rows))]
                    numbers = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
                    result = _aggregate(label, numbers)
                    ws.write_formula(total_index, c0 + i, f"={func}({column})", fmt, result)
                    b.values[(self.name, total_index, c0 + i)] = result
                else:
                    ws.write(total_index, c0 + i, label, fmt)
        # widths
        for i in range(n):
            if widths and i < len(widths) and widths[i]:
                width = widths[i]
            else:
                longest = max([_display_width(headers[i], "text") + 2] + [_display_width(row[i] if i < len(row) else None, kinds[i]) for row in rows] or [8])
                width = min(max(longest + 2, 9), 48)
            self._widths[c0 + i] = max(self._widths.get(c0 + i, 0), width)
            ws.set_column(c0 + i, c0 + i, self._widths[c0 + i])
        # Freeze the header only for a long table that has the sheet's one frozen pane to itself; a short
        # summary table gains nothing from it and loses screen space.
        if freeze is None:
            freeze = len(rows) >= 12 and not getattr(self, "_frozen", False)
        if freeze:
            ws.freeze_panes(header_row + 1, 0)
            self._frozen = True
        if filter and rows:
            ws.autofilter(header_row, c0, last, c0 + n - 1)
        # negatives in the theme's red, without touching the number format
        for i in range(n):
            if _is_numeric_kind(kinds[i]) and rows:
                ws.conditional_format(first, c0 + i, last, c0 + i, {"type": "cell", "criteria": "<", "value": 0,
                                                                  "format": b.wb.add_format({"font_color": f"#{NEGATIVE}"})})
        ws.repeat_rows(header_row)
        self.row = (total_index if total_index is not None else last) + 2
        return TableRef(self.name, header_row, first, last, c0, list(headers), total_index)

    def _write_value(self, r: int, c: int, value: Any, fmt, kind: str) -> None:
        ws = self.ws
        values = self.book.values
        if value is None or (isinstance(value, float) and math.isnan(value)):
            ws.write_blank(r, c, None, fmt)
        elif isinstance(value, (_dt.datetime, _dt.date)):
            stamp = value if isinstance(value, _dt.datetime) else _dt.datetime.combine(value, _dt.time())
            ws.write_datetime(r, c, stamp, fmt)
            values[(self.name, r, c)] = (stamp - _dt.datetime(1899, 12, 30)).total_seconds() / 86400
        elif isinstance(value, bool):
            ws.write_boolean(r, c, value, fmt)
            values[(self.name, r, c)] = value
        elif isinstance(value, (int, float)):
            ws.write_number(r, c, value, fmt)
            values[(self.name, r, c)] = value
        elif isinstance(value, str) and value.startswith("="):
            result = self.book.engine.evaluate(value, self.name)
            ws.write_formula(r, c, value, fmt, result if result is not None else 0)
            values[(self.name, r, c)] = result if result is not None else 0
        else:
            ws.write_string(r, c, str(value), fmt)
            values[(self.name, r, c)] = str(value)

    def put(self, cell: str, value: Any, kind: str = "text", bold: bool = False, color: str | None = None,
            result: Any = None) -> None:
        """Write one cell by address (for layouts that are not a table): put('B3', '=SUM(B1:B2)', 'money').

        For a formula the kit cannot calculate itself (SUMIFS, VLOOKUP, INDEX/MATCH...), compute the value
        in Python and pass it as `result=`, so the cell shows its number in every reader, not 0.
        """
        from xlsxwriter.utility import xl_cell_to_rowcol

        pattern, align = FORMATS.get(kind, (kind, "right"))
        props: dict[str, Any] = {"align": align, "bold": bold}
        if pattern:
            props["num_format"] = pattern
        if color:
            props["font_color"] = f"#{color}"
        r, c = xl_cell_to_rowcol(cell)
        fmt = self.book.fmt(**props)
        if result is not None and isinstance(value, str) and value.startswith("="):
            self.ws.write_formula(r, c, value, fmt, result)
            self.book.values[(self.name, r, c)] = result
            return
        self._write_value(r, c, value, fmt, kind)

    def _body_format(self, kind: str, wrap: bool, is_input: bool, last: bool):
        pattern, align = FORMATS.get(kind, (kind, "right"))
        props: dict[str, Any] = {"align": align, "bottom": 1, "bottom_color": f"#{HAIR}"}
        if pattern:
            props["num_format"] = pattern
        if wrap:
            props.update(text_wrap=True, valign="top")
        if is_input:
            props.update(font_color="#0000FF", bg_color="#FFF8E1")
        return self.book.fmt(**props)

    def _total_format(self, kind: str):
        pattern, align = FORMATS.get(kind, (kind, "right"))
        props: dict[str, Any] = {"align": align, "bold": True, "top": 1, "top_color": f"#{INK}", "bottom": 2, "bottom_color": f"#{INK}",
                                 "font_color": f"#{INK}"}
        if pattern:
            props["num_format"] = pattern
        return self.book.fmt(**props)

    # ------------------------------------------------------ assumptions
    def inputs(self, items: Sequence[tuple[str, Any, str]], note: str | None = None) -> dict[str, str]:
        """A labelled block of inputs (label, value, format). Inputs are blue on a light fill.

        Returns {label: absolute cell reference} so formulas can point at them.
        """
        b = self.book
        refs: dict[str, str] = {}
        width = max((len(label) for label, _, _ in items), default=10) + 2
        self.ws.set_column(self.col0, self.col0, max(width, 14))
        for label, value, kind in items:
            self.ws.write(self.row, self.col0, label, b.fmt(font_color=f"#{MUTED}", bottom=1, bottom_color=f"#{HAIR}"))
            pattern, align = FORMATS.get(kind, (kind, "right"))
            fmt = b.fmt(font_color="#0000FF", bg_color="#FFF8E1", align=align, num_format=pattern or "General",
                        bottom=1, bottom_color=f"#{HAIR}")
            self._write_value(self.row, self.col0 + 1, value, fmt, kind)
            refs[label] = f"{_quote(self.name)}!{a1(self.row, self.col0 + 1, True)}"
            self.row += 1
        self.ws.set_column(self.col0 + 1, self.col0 + 1, 16)
        if note:
            self.note(note)
        self.row += 1
        return refs

    def kpis(self, items: Sequence[tuple[str, Any, str]], span: int = 2) -> None:
        """A strip of headline numbers: (label, value, format). Each takes `span` columns."""
        b = self.book
        pad = b.fmt(bg_color=f"#{SURFACE}")
        for i, (label, value, kind) in enumerate(items):
            c = self.col0 + i * (span + 1)
            pattern, _ = FORMATS.get(kind, (kind, "left"))
            label_fmt = b.fmt(font_size=8, bold=True, font_color=f"#{MUTED}", bg_color=f"#{SURFACE}", top=2, top_color=f"#{self.theme.accent}")
            value_fmt = b.fmt(font_size=18, bold=True, font_color=f"#{INK}", bg_color=f"#{SURFACE}", align="left", num_format=pattern or "General")
            # A card is a display strip, not data: merged so a large number never shows as ###.
            self.ws.merge_range(self.row, c, self.row, c + span - 1, label.upper(), label_fmt)
            self.ws.merge_range(self.row + 1, c, self.row + 1, c + span - 1, "", value_fmt)
            self._write_value(self.row + 1, c, value, value_fmt, kind)
        self.ws.set_row(self.row, 16)
        self.ws.set_row(self.row + 1, 30)
        self.row += 3

    # -------------------------------------------------------- features
    def dropdown(self, cell_range: str, options: Sequence[str], prompt: str | None = None) -> None:
        """A dropdown list validation, e.g. dropdown('D2:D40', ['Open', 'Closed'])."""
        rule: dict[str, Any] = {"validate": "list", "source": list(options)}
        if prompt:
            rule.update(input_title="Choose", input_message=prompt)
        self.ws.data_validation(cell_range, rule)

    def data_bars(self, cell_range: str, color: str | None = None) -> None:
        self.ws.conditional_format(cell_range, {"type": "data_bar", "bar_solid": True, "bar_color": f"#{tint(color or self.theme.accent, 0.35)}"})

    def color_scale(self, cell_range: str) -> None:
        self.ws.conditional_format(cell_range, {"type": "2_color_scale", "min_color": "#FFFFFF", "max_color": f"#{tint(self.theme.accent, 0.35)}"})

    def flag(self, cell_range: str, criteria: str, value: Any, color: str = NEGATIVE) -> None:
        """Colour cells that meet a rule, e.g. flag('D2:D40', '>', 0.2)."""
        self.ws.conditional_format(cell_range, {"type": "cell", "criteria": criteria, "value": value,
                                                "format": self.book.wb.add_format({"font_color": f"#{color}", "bold": True})})

    def chart(self, kind: str, table: TableRef, categories: int, values: Sequence[int], anchor: str | None = None,
              title: str | None = None, size: tuple[int, int] = (560, 300), number_format: str | None = None,
              stacked: bool = False):
        """A native Excel chart from a table: category column index and value column indexes.

        kind: column, bar, line, pie, area. The chart is placed at `anchor` (default: right of the table).
        """
        b = self.book
        ctype = {"column": "column", "bar": "bar", "line": "line", "pie": "doughnut", "area": "area"}[kind]
        chart = b.wb.add_chart({"type": ctype, "subtype": "stacked" if stacked and kind in ("column", "bar", "area") else None} if stacked
                               else {"type": ctype})
        colors = [f"#{c}" for c in self.theme.series]
        font = {"name": self.theme.font, "size": 9, "color": f"#{MUTED}"}
        for n, idx in enumerate(values):
            series: dict[str, Any] = {
                "name": f"={table.header(idx)}",
                "categories": f"={table.range(categories)}",
                "values": f"={table.range(idx)}",
            }
            if kind == "line":
                series.update(line={"color": colors[n % len(colors)], "width": 2.25}, marker={"type": "circle", "size": 5,
                              "fill": {"color": colors[n % len(colors)]}, "border": {"color": colors[n % len(colors)]}})
            elif kind == "pie":
                series["points"] = [{"fill": {"color": colors[i % len(colors)]}} for i in range(table.last_row - table.first_row + 1)]
            else:
                series.update(fill={"color": colors[n % len(colors)]}, border={"none": True}, gap=60)
            chart.add_series(series)
        if title:
            chart.set_title({"name": title, "name_font": {"name": self.theme.font, "size": 11, "bold": True, "color": f"#{INK}"}, "overlay": False})
        else:
            chart.set_title({"none": True})
        if kind != "pie":
            chart.set_x_axis({"num_font": font, "line": {"color": f"#{RULE}"}, "major_tick_mark": "none"})
            y = {"num_font": font, "major_gridlines": {"visible": True, "line": {"color": f"#{HAIR}", "width": 0.75}}, "line": {"none": True}}
            if number_format:
                y["num_format"] = number_format
            chart.set_y_axis(y)
        chart.set_legend({"position": "bottom", "font": font} if len(values) > 1 or kind == "pie" else {"none": True})
        chart.set_chartarea({"border": {"none": True}, "fill": {"color": "#FFFFFF"}})
        chart.set_plotarea({"fill": {"none": True}})
        chart.set_size({"width": size[0], "height": size[1]})
        where = anchor or a1(table.header_row, table.first_col + len(table.columns) + 1)
        self.ws.insert_chart(where, chart, {"object_position": 1})
        return chart


# --------------------------------------------------------------- helpers


def _is_numeric_kind(kind: str) -> bool:
    if kind in _NUMERIC:
        return True
    return kind not in FORMATS and bool(re.search(r"[#0]", kind or "")) and not re.search(r"[ymd]", kind.lower().replace("\\", ""))


def _guess_kind(rows: Sequence[Sequence[Any]], i: int) -> str:
    values = [r[i] for r in rows if i < len(r) and r[i] is not None]
    if not values:
        return "text"
    if all(isinstance(v, (_dt.date, _dt.datetime)) for v in values):
        return "date"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values):
        return "int" if all(float(v).is_integer() for v in values) else "num2"
    return "text"


def _aggregate(kind: str, numbers: list[float]):
    if kind == "count":
        return len(numbers)
    if not numbers:
        return 0
    return {"sum": sum(numbers), "avg": sum(numbers) / len(numbers), "min": min(numbers), "max": max(numbers)}[kind]
