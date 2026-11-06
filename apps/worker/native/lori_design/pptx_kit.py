"""Slide decks with a flat, editorial look: one headline per slide, native charts and tables.

    from lori_design.pptx_kit import Deck
    deck = Deck("Q3 operations review", theme=Theme(accent="1E3A5F"))
    deck.title_slide("Q3 operations review", "Regional performance and priorities", "Operations | October 2026")
    deck.kpis("Sales reached $501K across three regions", [("Combined sales", "$501,560", "USD"), ...])
    deck.chart("AMER leads on sales; APAC leads on units", "column", ["EMEA", "APAC", "AMER"], {"Sales": [...]})
    deck.bullets("Recommendations", ["Validate the source data", ...], notes="Speaker notes here")
    deck.save("deck.pptx")

Slides use real title placeholders (outline view and screen readers work), native charts and
tables (editable in PowerPoint), 16:9, one font family and a restrained palette. Text is measured
against its box and shrunk to fit within a readable range; anything that still cannot fit is
reported in `deck.warnings` instead of silently overflowing.
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Sequence

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt
from lxml import etree

from .theme import DEFAULT, HAIR, INK, MUTED, RULE, SURFACE, TEXT, WHITE, Theme, on_color, rgb, tint

__all__ = ["Deck"]

SLIDE_W, SLIDE_H = 13.333, 7.5
MARGIN = 0.75
CONTENT_W = SLIDE_W - 2 * MARGIN
TITLE_TOP, TITLE_H = 0.55, 1.05
BODY_TOP, BODY_BOTTOM = 1.95, 6.7
FONT_PATHS = ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
FONT_PATHS_BOLD = ("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")


def _color(value: str) -> RGBColor:
    return RGBColor(*rgb(value))


def _font_file(bold: bool) -> str | None:
    for path in (FONT_PATHS_BOLD if bold else FONT_PATHS):
        if Path(path).exists():
            return path
    return None


def measure_lines(text: str, size_pt: float, width_in: float, bold: bool = False) -> int:
    """How many lines `text` needs at this size and width (wraps on words, like PowerPoint)."""
    from PIL import ImageFont

    path = _font_file(bold)
    if path is None:
        return max(1, int(len(text) * size_pt * 0.5 / 72 / width_in) + 1)
    font = ImageFont.truetype(path, int(size_pt * 10))
    max_px = width_in * 72 * 10
    lines = 0
    for paragraph in text.split("\n"):
        words, current = paragraph.split(" "), ""
        count = 1
        for word in words:
            trial = f"{current} {word}".strip()
            if font.getlength(trial) <= max_px or not current:
                current = trial
            else:
                count += 1
                current = word
        lines += count
    return lines


def fit_size(text: str, width_in: float, height_in: float, maximum: float, minimum: float,
             bold: bool = False, line_height: float = 1.2) -> tuple[float, bool]:
    """The largest font size in [minimum, maximum] at which `text` fits the box, and whether it fits at all."""
    size = maximum
    while size >= minimum:
        if measure_lines(text, size, width_in, bold) * size * line_height / 72 <= height_in:
            return size, True
        size -= 1
    return minimum, False


class Deck:
    def __init__(self, title: str = "", theme: Theme = DEFAULT, footer: str | None = None, numbers: bool = True):
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Inches(SLIDE_W), Inches(SLIDE_H)
        self.theme = theme
        self.title = title
        self.footer = title if footer is None else footer
        self.numbers = numbers
        self.warnings: list[str] = []
        self.prs.core_properties.title = title
        self.prs.core_properties.author = "Lori"
        self.prs.core_properties.comments = ""

    # ----------------------------------------------------------- primitives
    def _slide(self, layout: int):
        slide = self.prs.slides.add_slide(self.prs.slide_layouts[layout])
        return slide

    def _text(self, slide, x, y, w, h, text, size, color=TEXT, bold=False, align=PP_ALIGN.LEFT,
              anchor=MSO_ANCHOR.TOP, line=1.15, italic=False, name=None):
        box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        if name:
            box.name = name
        frame = box.text_frame
        frame.word_wrap = True
        frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
        frame.vertical_anchor = anchor
        paragraph = frame.paragraphs[0]
        paragraph.alignment = align
        paragraph.line_spacing = line
        run = paragraph.add_run()
        run.text = text
        self._style(run, size, color, bold, italic)
        return box

    def _style(self, run, size, color, bold=False, italic=False):
        run.font.name = self.theme.font
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.italic = italic
        run.font.color.rgb = _color(color)

    def _headline(self, slide, text: str, color: str = INK):
        """The slide's title, in the real title placeholder."""
        title = slide.shapes.title
        title.left, title.top, title.width, title.height = Inches(MARGIN), Inches(TITLE_TOP), Inches(CONTENT_W), Inches(TITLE_H)
        frame = title.text_frame
        frame.word_wrap = True
        frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
        frame.vertical_anchor = MSO_ANCHOR.TOP
        size, fits = fit_size(text, CONTENT_W, TITLE_H, 30, 22, bold=True, line_height=1.1)
        if not fits:
            self.warnings.append(f"Slide {len(self.prs.slides)}: the title is too long for two lines; shorten it: {text[:60]!r}")
        frame.text = ""
        paragraph = frame.paragraphs[0]
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.line_spacing = 1.1
        run = paragraph.add_run()
        run.text = text
        self._style(run, size, color, bold=True)

    def _chrome(self, slide, dark: bool = False):
        """Footer text and slide number: small, muted, and only where they help."""
        color = tint(self.theme.accent, 0.6) if dark else MUTED
        if self.footer:
            self._text(slide, MARGIN, 7.0, 8, 0.25, self.footer, 9, color, name="Footer")
        if self.numbers:
            number = len(self.prs.slides)
            self._text(slide, SLIDE_W - MARGIN - 1, 7.0, 1, 0.25, str(number), 9, color, align=PP_ALIGN.RIGHT, name="Slide number")

    def _notes(self, slide, notes: str | None):
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    def _clear_placeholders(self, slide, keep_title: bool = True):
        for shape in list(slide.placeholders):
            if keep_title and shape.placeholder_format.type is not None and shape == slide.shapes.title:
                continue
            shape._element.getparent().remove(shape._element)

    def _rect(self, slide, x, y, w, h, fill: str, line: str | None = None, name: str | None = None):
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = _color(fill)
        if line:
            shape.line.color.rgb = _color(line)
        else:
            shape.line.fill.background()
        shape.shadow.inherit = False
        if name:
            shape.name = name
        return shape

    @staticmethod
    def _bullet(paragraph, level: int = 0, char: str = "•") -> None:
        ppr = paragraph._p.get_or_add_pPr()
        ppr.set("marL", str(int(Inches(0.28 + 0.3 * level))))
        ppr.set("indent", str(-int(Inches(0.28))))
        for tag in ("a:buNone", "a:buChar", "a:buAutoNum"):
            for existing in ppr.findall(qn(tag)):
                ppr.remove(existing)
        bullet = etree.SubElement(ppr, qn("a:buChar"))
        bullet.set("char", char)

    # ---------------------------------------------------------------- slides
    def title_slide(self, title: str, subtitle: str | None = None, meta: str | None = None, notes: str | None = None):
        slide = self._slide(0)
        title_shape = slide.shapes.title
        for shape in list(slide.placeholders):
            if shape != title_shape:
                shape._element.getparent().remove(shape._element)
        self._rect(slide, 0, 0, 0.32, SLIDE_H, self.theme.accent, name="Accent edge")
        size, fits = fit_size(title, 10.5, 2.4, 44, 30, bold=True, line_height=1.05)
        if not fits:
            self.warnings.append(f"Title slide: the title is too long: {title[:60]!r}")
        # A real title placeholder keeps the outline and accessibility.
        title_shape.left, title_shape.top, title_shape.width, title_shape.height = Inches(1.1), Inches(2.1), Inches(10.5), Inches(2.4)
        frame = title_shape.text_frame
        frame.word_wrap = True
        frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
        frame.vertical_anchor = MSO_ANCHOR.BOTTOM
        frame.text = ""
        paragraph = frame.paragraphs[0]
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.line_spacing = 1.05
        run = paragraph.add_run()
        run.text = title
        self._style(run, size, INK, bold=True)
        if subtitle:
            self._text(slide, 1.1, 4.7, 10.5, 0.9, subtitle, 20, MUTED, line=1.2, name="Subtitle")
        if meta:
            self._text(slide, 1.1, 6.55, 10.5, 0.3, meta, 12, MUTED, name="Details")
        self._notes(slide, notes)
        return slide

    def section(self, title: str, note: str | None = None, notes: str | None = None):
        """A divider slide: solid accent, white title."""
        slide = self._slide(5)
        self._clear_placeholders(slide, keep_title=True)
        background = self._rect(slide, 0, 0, SLIDE_W, SLIDE_H, self.theme.accent, name="Background")
        # The background goes behind the title placeholder, at the bottom of the stacking order.
        slide.shapes._spTree.remove(background._element)
        slide.shapes._spTree.insert(2, background._element)
        title_shape = slide.shapes.title
        title_shape.left, title_shape.top, title_shape.width, title_shape.height = Inches(1.1), Inches(2.6), Inches(10.5), Inches(1.6)
        frame = title_shape.text_frame
        frame.word_wrap = True
        frame.vertical_anchor = MSO_ANCHOR.BOTTOM
        frame.text = ""
        run = frame.paragraphs[0].add_run()
        run.text = title
        frame.paragraphs[0].alignment = PP_ALIGN.LEFT
        size, _ = fit_size(title, 10.5, 1.6, 40, 28, bold=True, line_height=1.05)
        self._style(run, size, self.theme.on_accent, bold=True)
        if note:
            self._text(slide, 1.1, 4.4, 10.5, 1.0, note, 18, tint(self.theme.accent, 0.75) if self.theme.on_accent == WHITE else MUTED, line=1.2)
        self._notes(slide, notes)
        return slide

    def bullets(self, title: str, items: Sequence[str | tuple[str, Sequence[str]]], notes: str | None = None,
                lead: str | None = None):
        """A headline and up to six short points. Keep each point to one idea."""
        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._headline(slide, title)
        top = BODY_TOP
        if lead:
            self._text(slide, MARGIN, top, CONTENT_W, 0.6, lead, 18, MUTED, line=1.2)
            top += 0.85
        height = BODY_BOTTOM - top
        flat = [(it if isinstance(it, str) else it[0]) for it in items]
        joined = "\n".join(flat) + "\n" + "\n".join(c for it in items if not isinstance(it, str) for c in it[1])
        size, fits = fit_size(joined, CONTENT_W * 0.78 - 0.3, height, 22, 15, line_height=1.45)
        if not fits:
            self.warnings.append(f"Slide {len(self.prs.slides)}: too much text for one slide; split it: {title[:50]!r}")
        box = slide.shapes.add_textbox(Inches(MARGIN), Inches(top), Inches(CONTENT_W * 0.78), Inches(height))
        box.name = "Content"
        frame = box.text_frame
        frame.word_wrap = True
        frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
        first = True
        for item in items:
            text, children = (item, []) if isinstance(item, str) else (item[0], item[1])
            paragraph = frame.paragraphs[0] if first else frame.add_paragraph()
            first = False
            paragraph.line_spacing = 1.15
            paragraph.space_after = Pt(size * 0.55)
            self._bullet(paragraph)
            run = paragraph.add_run()
            run.text = text
            self._style(run, size, TEXT)
            for child in children:
                sub = frame.add_paragraph()
                sub.line_spacing = 1.1
                sub.space_after = Pt(size * 0.3)
                self._bullet(sub, level=1, char="–")
                r = sub.add_run()
                r.text = child
                self._style(r, size - 3, MUTED)
        self._chrome(slide)
        self._notes(slide, notes)
        return slide

    def kpis(self, title: str, items: Sequence[tuple[str, str] | tuple[str, str, str]], notes: str | None = None,
             caption: str | None = None):
        """Two to four headline numbers, large, with a label and an optional note."""
        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._headline(slide, title)
        count = len(items)
        gap = 0.4
        width = (CONTENT_W - gap * (count - 1)) / count
        top = 2.8
        for i, item in enumerate(items):
            label, value = item[0], item[1]
            note = item[2] if len(item) > 2 else None
            x = MARGIN + i * (width + gap)
            self._rect(slide, x, top, width, 0.05, self.theme.accent, name=f"KPI rule {i + 1}")
            vsize, _ = fit_size(value, width, 1.2, 54, 30, bold=True, line_height=1.0)
            self._text(slide, x, top + 0.3, width, 1.2, value, vsize, INK, bold=True, line=1.0, name=f"KPI value {i + 1}")
            self._text(slide, x, top + 1.6, width, 0.4, label, 16, TEXT, bold=True, name=f"KPI label {i + 1}")
            if note:
                self._text(slide, x, top + 2.05, width, 1.0, note, 13, MUTED, line=1.25, name=f"KPI note {i + 1}")
        if caption:
            self._text(slide, MARGIN, 6.2, CONTENT_W, 0.5, caption, 12, MUTED, line=1.25, name="Caption")
        self._chrome(slide)
        self._notes(slide, notes)
        return slide

    def chart(self, title: str, kind: str, categories: Sequence[str], series: dict[str, Sequence[float]],
              takeaway: str | None = None, number_format: str | None = None, notes: str | None = None, caption: str | None = None):
        """A native, editable chart. kind: column, bar, line, stacked, pie. `takeaway` adds a short side note.

        Without `number_format`, labels keep the data's own precision (up to two decimals) so values such
        as 3.1 are never shown as 3."""
        if number_format is None:
            places = max((len(f"{float(value):.2f}".rstrip("0").split(".")[1]) for values in series.values() for value in values), default=0)
            number_format = "#,##0" + ("." + "0" * places if places else "")
        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._headline(slide, title)
        data = CategoryChartData()
        data.categories = list(categories)
        for name, values in series.items():
            data.add_series(name, list(values))
        types = {"column": XL_CHART_TYPE.COLUMN_CLUSTERED, "bar": XL_CHART_TYPE.BAR_CLUSTERED, "line": XL_CHART_TYPE.LINE_MARKERS,
                 "stacked": XL_CHART_TYPE.COLUMN_STACKED, "pie": XL_CHART_TYPE.DOUGHNUT}
        width = CONTENT_W * (0.66 if takeaway else 1.0)
        height = BODY_BOTTOM - BODY_TOP - (0.45 if caption else 0)
        frame = slide.shapes.add_chart(types[kind], Inches(MARGIN), Inches(BODY_TOP), Inches(width), Inches(height), data)
        frame.name = "Chart"
        chart = frame.chart
        chart.font.name = self.theme.font
        chart.font.size = Pt(12)
        chart.font.color.rgb = _color(MUTED)
        chart.has_title = False
        colors = self.theme.series
        plot = chart.plots[0]
        if kind == "pie":
            chart.has_legend = True
            chart.legend.position = XL_LEGEND_POSITION.RIGHT
            chart.legend.include_in_layout = False
            for i, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = _color(colors[i % len(colors)])
            plot.has_data_labels = True
            plot.data_labels.number_format = "0%"
            plot.data_labels.show_percentage = True
            plot.data_labels.show_value = False
            plot.data_labels.font.size = Pt(12)
            plot.data_labels.font.color.rgb = _color(WHITE)
        else:
            for i, s in enumerate(plot.series):
                s.format.fill.solid()
                s.format.fill.fore_color.rgb = _color(colors[i % len(colors)])
                if kind == "line":
                    s.format.line.color.rgb = _color(colors[i % len(colors)])
                    s.format.line.width = Pt(2.5)
                    s.smooth = False
                    s.marker.format.fill.solid()
                    s.marker.format.fill.fore_color.rgb = _color(colors[i % len(colors)])
                    s.marker.format.line.color.rgb = _color(colors[i % len(colors)])
            if kind in ("column", "bar", "stacked"):
                plot.gap_width = 55
                plot.overlap = 100 if kind == "stacked" else -10
            plot.has_data_labels = True
            labels = plot.data_labels
            labels.number_format = number_format
            labels.number_format_is_linked = False
            labels.font.size = Pt(12 if kind != "stacked" else 11)
            # Labels inside a stacked segment need the segment's contrasting colour; the rest sit outside.
            labels.font.color.rgb = _color(WHITE if kind == "stacked" else TEXT)
            if kind in ("column", "bar"):
                labels.position = XL_LABEL_POSITION.OUTSIDE_END
            elif kind == "line":
                labels.position = XL_LABEL_POSITION.ABOVE
            elif kind == "stacked":
                labels.position = XL_LABEL_POSITION.CENTER
            chart.has_legend = len(series) > 1
            if chart.has_legend:
                chart.legend.position = XL_LEGEND_POSITION.BOTTOM
                chart.legend.include_in_layout = False
                chart.legend.font.size = Pt(12)
            value_axis, category_axis = chart.value_axis, chart.category_axis
            if kind != "line":
                # Bars start at zero; a cut axis makes small differences look large.
                value_axis.minimum_scale = 0
            value_axis.has_major_gridlines = True
            value_axis.major_gridlines.format.line.color.rgb = _color(HAIR)
            value_axis.major_gridlines.format.line.width = Pt(0.75)
            value_axis.format.line.fill.background()
            value_axis.tick_labels.number_format = number_format
            value_axis.tick_labels.number_format_is_linked = False
            value_axis.tick_labels.font.size = Pt(11)
            category_axis.format.line.color.rgb = _color(RULE)
            category_axis.tick_labels.font.size = Pt(12)
            category_axis.has_major_gridlines = False
        if takeaway:
            x = MARGIN + width + 0.45
            self._rect(slide, x, BODY_TOP + 0.1, 0.05, 1.0, self.theme.accent, name="Takeaway rule")
            size, fits = fit_size(takeaway, CONTENT_W - width - 0.75, 3.8, 20, 14, line_height=1.3)
            self._text(slide, x + 0.25, BODY_TOP + 0.05, CONTENT_W - width - 0.7, 3.9, takeaway, size, TEXT, line=1.3, name="Takeaway")
        if caption:
            self._text(slide, MARGIN, 6.45, CONTENT_W, 0.35, caption, 11, MUTED, name="Source")
        self._chrome(slide)
        self._notes(slide, notes)
        return slide

    def table(self, title: str, headers: Sequence[str], rows: Sequence[Sequence[object]], widths: Sequence[float] | None = None,
              align: str | None = None, notes: str | None = None, caption: str | None = None, total_row: bool = False):
        """A native table. Numbers are right-aligned; keep it to about eight rows."""
        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._headline(slide, title)
        count = len(rows) + 1
        row_h = min(0.55, (BODY_BOTTOM - BODY_TOP - 0.1) / count)
        font_size = 16 if row_h >= 0.5 else 14 if row_h >= 0.42 else 12
        weights = list(widths) if widths else [1.0] * len(headers)
        scale = CONTENT_W / sum(weights)
        shape = slide.shapes.add_table(count, len(headers), Inches(MARGIN), Inches(BODY_TOP), Inches(CONTENT_W), Inches(row_h * count))
        shape.name = "Table"
        table = shape.table
        tbl_pr = table._tbl.tblPr
        for attr in ("firstRow", "bandRow"):
            tbl_pr.set(attr, "0")
        style_id = tbl_pr.find(qn("a:tableStyleId"))
        if style_id is not None:
            tbl_pr.remove(style_id)
        import re

        numeric = re.compile(r"^[\s$€£(−-]*[\d.,]+[)%xKMB]*$")
        aligns = list(align) if align else ["r" if rows and all(numeric.match(str(r[i])) for r in rows) else "l" for i in range(len(headers))]
        for i, w in enumerate(weights):
            table.columns[i].width = Inches(w * scale)
        for r in range(count):
            table.rows[r].height = Inches(row_h)
            for c in range(len(headers)):
                cell = table.cell(r, c)
                cell.margin_left = cell.margin_right = Inches(0.14)
                cell.margin_top = cell.margin_bottom = Inches(0.05)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                header = r == 0
                total = total_row and r == count - 1
                text = str(headers[c]) if header else ("" if rows[r - 1][c] is None else str(rows[r - 1][c]))
                frame = cell.text_frame
                frame.word_wrap = True
                paragraph = frame.paragraphs[0]
                paragraph.alignment = {"l": PP_ALIGN.LEFT, "r": PP_ALIGN.RIGHT, "c": PP_ALIGN.CENTER}[aligns[c]]
                run = paragraph.add_run()
                run.text = text
                self._style(run, font_size - (1 if header else 0), on_color(self.theme.accent) if header else (INK if total else TEXT),
                            bold=header or total)
                cell.fill.solid()
                cell.fill.fore_color.rgb = _color(self.theme.accent if header else WHITE)
                self._borders(cell, bottom=("0" if header else ("19050" if total or r == count - 1 else "6350"), INK if total or r == count - 1 else HAIR))
        if caption:
            self._text(slide, MARGIN, 6.45, CONTENT_W, 0.35, caption, 11, MUTED, name="Source")
        self._chrome(slide)
        self._notes(slide, notes)
        return slide

    @staticmethod
    def _borders(cell, bottom: tuple[str, str]) -> None:
        tc_pr = cell._tc.get_or_add_tcPr()
        for edge in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
            for existing in tc_pr.findall(qn(edge)):
                tc_pr.remove(existing)
        for edge in ("a:lnL", "a:lnR", "a:lnT"):
            line = etree.SubElement(tc_pr, qn(edge))
            line.set("w", "0")
            etree.SubElement(line, qn("a:noFill"))
        width, color = bottom
        line = etree.SubElement(tc_pr, qn("a:lnB"))
        line.set("w", width)
        if width == "0":
            etree.SubElement(line, qn("a:noFill"))
        else:
            fill = etree.SubElement(line, qn("a:solidFill"))
            etree.SubElement(fill, qn("a:srgbClr")).set("val", color)
        # a:tcPr children must precede the fill element
        fills = [e for e in tc_pr if e.tag in (qn("a:solidFill"), qn("a:noFill"))]
        for element in fills:
            tc_pr.remove(element)
            tc_pr.append(element)

    def two_column(self, title: str, left_heading: str, left: Sequence[str], right_heading: str, right: Sequence[str],
                   notes: str | None = None):
        """Two short lists side by side, each with a heading (for comparisons and before/after)."""
        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._headline(slide, title)
        gap = 0.7
        width = (CONTENT_W - gap) / 2
        for i, (heading, items) in enumerate(((left_heading, left), (right_heading, right))):
            x = MARGIN + i * (width + gap)
            self._rect(slide, x, BODY_TOP, width, 0.05, self.theme.accent if i == 0 else RULE, name=f"Column rule {i + 1}")
            self._text(slide, x, BODY_TOP + 0.25, width, 0.5, heading, 20, INK, bold=True, name=f"Column heading {i + 1}")
            size, fits = fit_size("\n".join(items), width - 0.3, BODY_BOTTOM - BODY_TOP - 1.0, 20, 14, line_height=1.45)
            if not fits:
                self.warnings.append(f"Slide {len(self.prs.slides)}: column {i + 1} has too much text")
            box = slide.shapes.add_textbox(Inches(x), Inches(BODY_TOP + 0.95), Inches(width), Inches(BODY_BOTTOM - BODY_TOP - 1.0))
            box.name = f"Column {i + 1}"
            frame = box.text_frame
            frame.word_wrap = True
            frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
            for k, text in enumerate(items):
                paragraph = frame.paragraphs[0] if k == 0 else frame.add_paragraph()
                paragraph.line_spacing = 1.15
                paragraph.space_after = Pt(size * 0.55)
                self._bullet(paragraph)
                run = paragraph.add_run()
                run.text = text
                self._style(run, size, TEXT)
        self._chrome(slide)
        self._notes(slide, notes)
        return slide

    def image(self, title: str, path: str, caption: str | None = None, notes: str | None = None):
        """A picture sized to fit the body, centred, never stretched."""
        from PIL import Image

        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._headline(slide, title)
        with Image.open(path) as image:
            ratio = image.width / image.height
        max_w, max_h = CONTENT_W, BODY_BOTTOM - BODY_TOP - (0.4 if caption else 0)
        width = min(max_w, max_h * ratio)
        height = width / ratio
        x = MARGIN + (CONTENT_W - width) / 2
        picture = slide.shapes.add_picture(path, Inches(x), Inches(BODY_TOP), Inches(width), Inches(height))
        picture.name = "Picture"
        if caption:
            self._text(slide, MARGIN, BODY_TOP + height + 0.12, CONTENT_W, 0.3, caption, 11, MUTED, align=PP_ALIGN.CENTER, name="Caption")
        self._chrome(slide)
        self._notes(slide, notes)
        return slide

    def closing(self, title: str, lines: Sequence[str] = (), notes: str | None = None):
        """A last slide: next steps or contacts, left-aligned like the title slide."""
        slide = self._slide(5)
        self._clear_placeholders(slide)
        self._rect(slide, 0, 0, 0.32, SLIDE_H, self.theme.accent, name="Accent edge")
        title_shape = slide.shapes.title
        title_shape.left, title_shape.top, title_shape.width, title_shape.height = Inches(1.1), Inches(2.4), Inches(10.5), Inches(1.5)
        frame = title_shape.text_frame
        frame.word_wrap = True
        frame.vertical_anchor = MSO_ANCHOR.BOTTOM
        frame.text = ""
        run = frame.paragraphs[0].add_run()
        run.text = title
        frame.paragraphs[0].alignment = PP_ALIGN.LEFT
        size, _ = fit_size(title, 10.5, 1.5, 40, 28, bold=True, line_height=1.05)
        self._style(run, size, INK, bold=True)
        for i, line in enumerate(lines):
            self._text(slide, 1.1, 4.15 + i * 0.5, 10.5, 0.45, line, 18, MUTED if i else TEXT, name=f"Line {i + 1}")
        self._notes(slide, notes)
        return slide

    def save(self, path: str) -> str:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.prs.save(path)
        return path
