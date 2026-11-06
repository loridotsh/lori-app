"""Word documents that look designed, not defaulted.

    from lori_design.docx_kit import *
    doc = new_document("Q3 operations review", subtitle="Regional performance", author="Operations")
    h1(doc, "Executive summary")
    para(doc, "Revenue grew **12%** on stronger _EMEA_ demand.")
    kpis(doc, [("Revenue", "$4.2M", "+12% vs Q2"), ("Orders", "1,840", "+6%")])
    table(doc, ["Region", "Revenue", "Share"], rows, align="lrr", total_row=True)
    save(doc, "report.docx")

Everything here uses real Word structure (styles, heading levels, list numbering,
repeating table headers, page-number fields), so documents navigate, restyle and
reflow correctly. Nothing relies on blank paragraphs for spacing.
"""
from __future__ import annotations

import os
import re
import tempfile
from math import isfinite
from pathlib import Path
from typing import Iterable, Sequence

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt, RGBColor

from .theme import DEFAULT, HAIR, INK, MUTED, RULE, SURFACE, TEXT, WHITE, Theme, on_color, rgb

__all__ = [
    "new_document", "title_block", "h1", "h2", "h3", "para", "bullets", "numbered", "table",
    "kpis", "callout", "quote", "figure", "chart", "page_break", "landscape_section",
    "portrait_section", "contents", "save", "money", "pct", "num",
]

PAGE_SIZES = {"letter": (8.5, 11.0), "a4": (8.27, 11.69)}
_THEMES: dict[int, Theme] = {}


def _theme(doc: Document) -> Theme:
    return _THEMES.get(id(doc), DEFAULT)


def _color(value: str) -> RGBColor:
    return RGBColor(*rgb(value))


# ---------------------------------------------------------------- formatting


def money(value: float, symbol: str = "$", decimals: int = 0) -> str:
    """$1,234 / ($1,234) for negatives, the accounting convention."""
    text = f"{symbol}{abs(value):,.{decimals}f}"
    return f"({text})" if value < 0 else text


def pct(value: float, decimals: int = 1) -> str:
    """0.123 -> '12.3%'. Pass a fraction, not a percentage."""
    return f"{value * 100:,.{decimals}f}%"


def num(value: float, decimals: int = 0) -> str:
    return f"{value:,.{decimals}f}"


# ------------------------------------------------------------------ plumbing


def _font(target, name: str, size: float | None = None, bold: bool | None = None,
          italic: bool | None = None, color: str | None = None) -> None:
    """Set a font on a style or run, and remove theme-font overrides that would win over it."""
    font = target.font
    font.name = name
    if size is not None:
        font.size = Pt(size)
    if bold is not None:
        font.bold = bold
    if italic is not None:
        font.italic = italic
    if color is not None:
        font.color.rgb = _color(color)
    element = target.element if hasattr(target, "element") else target._element
    rpr = element.get_or_add_rPr() if hasattr(element, "get_or_add_rPr") else element.rPr
    if color is not None and rpr.color is not None:
        for attribute in ("w:themeColor", "w:themeTint", "w:themeShade"):
            rpr.color.attrib.pop(qn(attribute), None)
    fonts = rpr.rFonts
    if fonts is not None:
        for attribute in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
            key = qn(attribute)
            if key in fonts.attrib:
                del fonts.attrib[key]
        fonts.set(qn("w:eastAsia"), name)
        fonts.set(qn("w:cs"), name)


def _spacing(style, before: float = 0, after: float = 0, line: float | None = None,
             keep_next: bool = False, keep_together: bool = False) -> None:
    fmt = style.paragraph_format
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    if line is not None:
        fmt.line_spacing = line
    fmt.keep_with_next = keep_next
    fmt.keep_together = keep_together
    fmt.widow_control = True


def _set_cell_shading(cell, color: str | None) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    for existing in tc_pr.findall(qn("w:shd")):
        tc_pr.remove(existing)
    if color:
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), color)
        tc_pr.append(shd)


def _set_cell_borders(cell, **edges: tuple[str, float, str] | None) -> None:
    """edges: top/bottom/left/right=(style, size_pt, colour) or None for no border."""
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.find(qn("w:tcBorders"))
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right"):
        if edge not in edges:
            continue
        for existing in borders.findall(qn(f"w:{edge}")):
            borders.remove(existing)
        element = OxmlElement(f"w:{edge}")
        spec = edges[edge]
        if spec is None:
            element.set(qn("w:val"), "nil")
        else:
            style, size, color = spec
            element.set(qn("w:val"), style)
            element.set(qn("w:sz"), str(int(size * 8)))
            element.set(qn("w:space"), "0")
            element.set(qn("w:color"), color)
        borders.append(element)


def _cell_margins(cell, top: float = 0, bottom: float = 0, left: float = 0, right: float = 0) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    margins = tc_pr.find(qn("w:tcMar"))
    if margins is None:
        margins = OxmlElement("w:tcMar")
        tc_pr.append(margins)
    for edge, value in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        for existing in margins.findall(qn(f"w:{edge}")):
            margins.remove(existing)
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:w"), str(int(value * 20)))
        element.set(qn("w:type"), "dxa")
        margins.append(element)


def _table_defaults(tbl, width_in: float) -> None:
    tbl.autofit = False
    tbl.alignment = WD_TABLE_ALIGNMENT.LEFT
    tbl_pr = tbl._tbl.tblPr
    # No inherited style borders; each table sets exactly the lines it wants.
    for existing in tbl_pr.findall(qn("w:tblBorders")):
        tbl_pr.remove(existing)
    # Setting autofit already maintains the single tblLayout element.
    width = tbl_pr.find(qn("w:tblW"))
    if width is None:
        width = OxmlElement("w:tblW")
        tbl_pr.append(width)
    width.set(qn("w:w"), str(int(width_in * 1440)))
    width.set(qn("w:type"), "dxa")


def _content_width(doc: Document) -> float:
    section = doc.sections[-1]
    return (section.page_width - section.left_margin - section.right_margin) / 914400


def _add_field(paragraph, instruction: str, style=None) -> None:
    """A Word field (PAGE, NUMPAGES). Each part is its own run so every one carries the same formatting."""
    def part(element) -> None:
        run = paragraph.add_run()
        run._r.append(element)
        if style:
            style(run)

    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    code = OxmlElement("w:instrText")
    code.set(qn("xml:space"), "preserve")
    code.text = instruction
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    placeholder = OxmlElement("w:t")
    placeholder.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for element in (begin, code, separate, placeholder, end):
        part(element)


# ---------------------------------------------------------------- rich text

_INLINE = re.compile(r"(\*\*.+?\*\*|`.+?`|(?<![\w])_.+?_(?![\w]))")


def _rich(paragraph, text: str, theme: Theme, size: float | None = None, color: str | None = None) -> None:
    """**bold**, _italic_ and `code` inside a string."""
    for part in _INLINE.split(text):
        if not part:
            continue
        run = None
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            run = paragraph.add_run(part[1:-1])
            _font(run, "Liberation Mono", (size or 10.5) - 1, color=color or TEXT)
            continue
        elif part.startswith("_") and part.endswith("_") and len(part) > 2:
            run = paragraph.add_run(part[1:-1])
            run.italic = True
        else:
            run = paragraph.add_run(part)
        if size is not None:
            run.font.size = Pt(size)
        if color is not None:
            run.font.color.rgb = _color(color)


# ------------------------------------------------------------------ document


def new_document(
    title: str | None = None,
    subtitle: str | None = None,
    author: str = "",
    theme: Theme = DEFAULT,
    page: str = "letter",
    margins: float = 1.0,
    landscape: bool = False,
    footer: bool = True,
    footer_text: str | None = None,
    header_text: str | None = None,
    body_size: float = 10.5,
    meta: str | None = None,
) -> Document:
    """A document with its styles, margins, footer and page numbers already in place.

    `title` adds a title block at the top. `footer_text` is optional;
    leave it empty for page numbers alone, especially with a long title.
    `meta` is one muted line under the title (a date, a team, a version).
    """
    doc = Document()
    _THEMES[id(doc)] = theme
    width, height = PAGE_SIZES.get(page.lower(), PAGE_SIZES["letter"])
    section = doc.sections[0]
    if landscape:
        section.orientation = WD_ORIENT.LANDSCAPE
        width, height = height, width
    section.page_width, section.page_height = Inches(width), Inches(height)
    section.left_margin = section.right_margin = Inches(margins)
    section.top_margin = Inches(margins * 0.9)
    section.bottom_margin = Inches(margins * 0.9)
    section.header_distance = section.footer_distance = Inches(0.45)

    styles = doc.styles
    font = theme.font
    normal = styles["Normal"]
    _font(normal, font, body_size, color=TEXT)
    _spacing(normal, after=6, line=1.2)
    for name, size, color, before, after in (
        ("Title", 26, INK, 0, 4),
        ("Subtitle", 12.5, MUTED, 0, 10),
        ("Heading 1", 17, theme.heading_ink, 20, 6),
        ("Heading 2", 13, theme.readable_accent, 14, 4),
        ("Heading 3", 11, TEXT, 10, 3),
    ):
        style = styles[name]
        _font(style, font, size, bold=name != "Subtitle", italic=False, color=color)
        _spacing(style, before, after, line=1.1 if name == "Title" else 1.15,
                 keep_next=True)
        style.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
        # The default template draws a rule under titles; remove it.
        ppr = style.element.get_or_add_pPr()
        for border in ppr.findall(qn("w:pBdr")):
            ppr.remove(border)
        # ...and the template's letter-spacing on the subtitle.
        rpr = style.element.get_or_add_rPr()
        for spacing in rpr.findall(qn("w:spacing")):
            rpr.remove(spacing)
    caption = styles["Caption"]
    _font(caption, font, 8.5, bold=False, italic=False, color=MUTED)
    _spacing(caption, before=3, after=10, keep_together=True)
    for name in ("List Bullet", "List Number", "List Bullet 2", "List Number 2"):
        style = styles[name]
        _font(style, font, body_size, color=TEXT)
        _spacing(style, after=3, line=1.2)
    for name in ("Quote", "Intense Quote"):
        _font(styles[name], font, body_size + 0.5, italic=True, color=MUTED)

    # Footer: document name on the left, "Page X of Y" on the right.
    if footer:
        footer_par = section.footer.paragraphs[0]
        footer_par.text = ""
        # The built-in Footer style carries centre and right tab stops; start from Normal so only ours exist.
        footer_par.style = styles["Normal"]
        width_in = width - 2 * margins
        footer_par.paragraph_format.tab_stops.add_tab_stop(Inches(width_in), WD_TAB_ALIGNMENT.RIGHT)
        _spacing_par(footer_par, 0, 0)
        footer_par.paragraph_format.line_spacing = 1.0
        small = lambda run: _font(run, font, 8, color=MUTED)
        label = footer_text or ""
        for text in (label, "\tPage "):
            small(footer_par.add_run(text))
        _add_field(footer_par, " PAGE ", small)
        small(footer_par.add_run(" of "))
        _add_field(footer_par, " NUMPAGES ", small)
    if header_text:
        header_par = section.header.paragraphs[0]
        header_par.text = ""
        run = header_par.add_run(header_text)
        _font(run, font, 8, color=MUTED)

    props = doc.core_properties
    props.title = title or ""
    props.author = author
    props.comments = ""
    if title:
        title_block(doc, title, subtitle, meta)
    return doc


def _spacing_par(paragraph, before: float, after: float) -> None:
    paragraph.paragraph_format.space_before = Pt(before)
    paragraph.paragraph_format.space_after = Pt(after)


def title_block(doc: Document, title: str, subtitle: str | None = None, meta: str | None = None) -> None:
    """Title, optional subtitle and one muted metadata line. No rules, no blank lines."""
    doc.add_paragraph(title, style="Title")
    if subtitle:
        doc.add_paragraph(subtitle, style="Subtitle")
    if meta:
        paragraph = doc.add_paragraph()
        _spacing_par(paragraph, 0 if subtitle else 2, 14)
        run = paragraph.add_run(meta)
        _font(run, _theme(doc).font, 9, color=MUTED)


def h1(doc: Document, text: str):
    return doc.add_paragraph(text, style="Heading 1")


def h2(doc: Document, text: str):
    return doc.add_paragraph(text, style="Heading 2")


def h3(doc: Document, text: str):
    return doc.add_paragraph(text, style="Heading 3")


def para(doc: Document, text: str, size: float | None = None, color: str | None = None,
         align: str = "l", keep_next: bool = False):
    """A paragraph. Supports **bold**, _italic_ and `code`."""
    paragraph = doc.add_paragraph()
    _rich(paragraph, text, _theme(doc), size, color)
    paragraph.alignment = {"l": WD_ALIGN_PARAGRAPH.LEFT, "c": WD_ALIGN_PARAGRAPH.CENTER,
                           "r": WD_ALIGN_PARAGRAPH.RIGHT, "j": WD_ALIGN_PARAGRAPH.JUSTIFY}[align]
    if keep_next:
        paragraph.paragraph_format.keep_with_next = True
    return paragraph


def bullets(doc: Document, items: Iterable[str | tuple[str, list[str]]]):
    """A real bulleted list. An item can be (text, [sub-items])."""
    paragraphs = []
    for item in items:
        text, children = item if isinstance(item, tuple) else (item, [])
        paragraph = doc.add_paragraph(style="List Bullet")
        _rich(paragraph, text, _theme(doc))
        paragraphs.append(paragraph)
        for child in children:
            sub = doc.add_paragraph(style="List Bullet 2")
            _rich(sub, child, _theme(doc))
            paragraphs.append(sub)
    if paragraphs:
        paragraphs[-1].paragraph_format.space_after = Pt(8)
    return paragraphs


def _restart_numbering(doc: Document, paragraph) -> None:
    """Give this list its own counter so it starts at 1 instead of continuing an earlier list."""
    numbering = doc.part.numbering_part.numbering_definitions._numbering
    style_num = doc.styles["List Number"].element.pPr.numPr.numId.val
    abstract = None
    for num_element in numbering.findall(qn("w:num")):
        if int(num_element.get(qn("w:numId"))) == int(style_num):
            abstract = num_element.find(qn("w:abstractNumId")).get(qn("w:val"))
    if abstract is None:
        return
    new_id = max(int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))) + 1
    num_element = OxmlElement("w:num")
    num_element.set(qn("w:numId"), str(new_id))
    abstract_ref = OxmlElement("w:abstractNumId")
    abstract_ref.set(qn("w:val"), abstract)
    override = OxmlElement("w:lvlOverride")
    override.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:startOverride")
    start.set(qn("w:val"), "1")
    override.append(start)
    num_element.append(abstract_ref)
    num_element.append(override)
    numbering.append(num_element)
    ppr = paragraph._p.get_or_add_pPr()
    num_pr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl")
    ilvl.set(qn("w:val"), "0")
    num_id = OxmlElement("w:numId")
    num_id.set(qn("w:val"), str(new_id))
    num_pr.append(ilvl)
    num_pr.append(num_id)
    ppr.append(num_pr)
    doc._lori_numbering = new_id  # remembered for the rest of this list


def numbered(doc: Document, items: Iterable[str]):
    """A real numbered list that starts at 1."""
    paragraphs = []
    for index, text in enumerate(items):
        paragraph = doc.add_paragraph(style="List Number")
        _rich(paragraph, text, _theme(doc))
        if index == 0:
            _restart_numbering(doc, paragraph)
        else:
            ppr = paragraph._p.get_or_add_pPr()
            num_pr = OxmlElement("w:numPr")
            ilvl = OxmlElement("w:ilvl")
            ilvl.set(qn("w:val"), "0")
            num_id = OxmlElement("w:numId")
            num_id.set(qn("w:val"), str(doc._lori_numbering))
            num_pr.append(ilvl)
            num_pr.append(num_id)
            ppr.append(num_pr)
        paragraphs.append(paragraph)
    if paragraphs:
        paragraphs[-1].paragraph_format.space_after = Pt(8)
    return paragraphs


# -------------------------------------------------------------------- tables


def table(
    doc: Document,
    headers: Sequence[str],
    rows: Sequence[Sequence[object]],
    widths: Sequence[float] | None = None,
    align: str | Sequence[str] | None = None,
    total_row: bool = False,
    zebra: bool = False,
    size: float = 9.5,
    caption: str | None = None,
    header_fill: str | None = None,
):
    """A data table: dark header that repeats on every page, hairline row rules, numbers right-aligned.

    widths are relative weights (they are scaled to the page width). align is one
    letter per column (l, c, r), for example "lrr". Columns that look numeric
    default to right-aligned. total_row styles the last row as a total.
    """
    theme = _theme(doc)
    columns = len(headers)
    total_width = _content_width(doc)
    weights = list(widths) if widths is not None else [1.0] * columns
    if (not columns or len(weights) != columns or
            any(not isfinite(w) or w <= 0 for w in weights) or
            any(len(row) > columns for row in rows)):
        raise ValueError("Tables require headers, positive column widths and rows with no extra columns")
    scale = total_width / sum(weights)
    col_widths = [w * scale for w in weights]
    if align is None:
        numeric = re.compile(r"^[\s$€£(−-]*[\d.,]+[)%xKMB]*$")
        align = "".join("r" if rows and all(numeric.match(str(r[i])) for r in rows if i < len(r)) else "l"
                        for i in range(columns))
    alignments = {"l": WD_ALIGN_PARAGRAPH.LEFT, "c": WD_ALIGN_PARAGRAPH.CENTER, "r": WD_ALIGN_PARAGRAPH.RIGHT}
    if len(align) != columns or any(a not in alignments for a in align):
        raise ValueError("Table align must contain one l/c/r character per column")

    tbl = doc.add_table(rows=1 + len(rows), cols=columns)
    _table_defaults(tbl, total_width)
    # Keep tblGrid and tcW in agreement: renderers can otherwise ignore the
    # requested proportions and squeeze a description column to equal width.
    for column, width_in in zip(tbl.columns, col_widths):
        column.width = Inches(width_in)
    fill = header_fill or theme.accent
    last = len(rows)
    for row_index, row in enumerate(tbl.rows):
        tr_pr = row._tr.get_or_add_trPr()
        if row_index == 0:
            header = OxmlElement("w:tblHeader")
            tr_pr.append(header)
        for col_index, cell in enumerate(row.cells):
            cell.width = Inches(col_widths[col_index])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            if row_index == 0:
                text, bold, color = str(headers[col_index]), True, on_color(fill)
            else:
                data = rows[row_index - 1]
                text = "" if col_index >= len(data) or data[col_index] is None else str(data[col_index])
                is_total = total_row and row_index == last
                bold, color = is_total, INK if is_total else TEXT
            paragraph = cell.paragraphs[0]
            paragraph.text = ""
            _spacing_par(paragraph, 0, 0)
            paragraph.paragraph_format.line_spacing = 1.1
            paragraph.paragraph_format.keep_with_next = row_index == 0
            paragraph.alignment = alignments[align[col_index]]
            _rich(paragraph, text, theme, size, color)
            if bold:
                for run in paragraph.runs:
                    run.bold = True
            _cell_margins(cell, top=4.5, bottom=4.5, left=7, right=7)
            if row_index == 0:
                _set_cell_shading(cell, fill)
                _set_cell_borders(cell, top=None, left=None, right=None, bottom=None)
            else:
                shaded = zebra and row_index % 2 == 0
                _set_cell_shading(cell, SURFACE if shaded else None)
                is_total = total_row and row_index == last
                _set_cell_borders(
                    cell, left=None, right=None,
                    top=("single", 1, INK) if is_total else None,
                    bottom=("single", 1.5, INK) if row_index == last else ("single", 0.5, HAIR),
                )
    if caption:
        doc.add_paragraph(caption, style="Caption")
    else:
        spacer = doc.add_paragraph()
        _spacing_par(spacer, 0, 4)
        spacer.paragraph_format.line_spacing = 0.6
    return tbl


def kpis(doc: Document, items: Sequence[tuple[str, str] | tuple[str, str, str]]):
    """A row of headline numbers: (label, value) or (label, value, note)."""
    theme = _theme(doc)
    total_width = _content_width(doc)
    gap = 0.14
    tbl = doc.add_table(rows=1, cols=len(items))
    _table_defaults(tbl, total_width)
    column = (total_width - gap * (len(items) - 1)) / len(items)
    tbl_pr = tbl._tbl.tblPr
    spacing = OxmlElement("w:tblCellSpacing")
    spacing.set(qn("w:w"), str(int(gap * 1440 / 2)))
    spacing.set(qn("w:type"), "dxa")
    tbl_pr.append(spacing)
    for index, (cell, item) in enumerate(zip(tbl.rows[0].cells, items)):
        label, value = item[0], item[1]
        note = item[2] if len(item) > 2 else None
        cell.width = Inches(column + gap / 2)
        _set_cell_shading(cell, SURFACE)
        _set_cell_borders(cell, top=("single", 2.25, theme.accent), left=None, right=None, bottom=None)
        _cell_margins(cell, top=9, bottom=9, left=11, right=9)
        first = cell.paragraphs[0]
        _spacing_par(first, 0, 2)
        run = first.add_run(label.upper())
        _font(run, theme.font, 7.5, bold=True, color=MUTED)
        value_par = cell.add_paragraph()
        _spacing_par(value_par, 0, 1)
        value_par.paragraph_format.line_spacing = 1.0
        _font(value_par.add_run(value), theme.font, 20, bold=True, color=INK)
        if note:
            note_par = cell.add_paragraph()
            _spacing_par(note_par, 0, 0)
            note_par.paragraph_format.line_spacing = 1.05
            _font(note_par.add_run(note), theme.font, 8.5, color=MUTED)
    spacer = doc.add_paragraph()
    _spacing_par(spacer, 0, 6)
    spacer.paragraph_format.line_spacing = 0.6
    return tbl


def callout(doc: Document, text: str, title: str | None = None, tone: str = "note"):
    """A boxed note with an accent bar: tone is note, positive, warning or risk."""
    from .theme import NEGATIVE, POSITIVE, WARNING, tint

    theme = _theme(doc)
    color = {"note": theme.accent, "positive": POSITIVE, "warning": WARNING, "risk": NEGATIVE}.get(tone, theme.accent)
    tbl = doc.add_table(rows=1, cols=1)
    _table_defaults(tbl, _content_width(doc))
    cell = tbl.rows[0].cells[0]
    cell.width = Inches(_content_width(doc))
    _set_cell_shading(cell, tint(color, 0.93))
    _set_cell_borders(cell, left=("single", 3, color), top=None, right=None, bottom=None)
    _cell_margins(cell, top=8, bottom=8, left=12, right=12)
    paragraph = cell.paragraphs[0]
    paragraph.paragraph_format.keep_together = True
    _spacing_par(paragraph, 0, 0)
    if title:
        run = paragraph.add_run(title + "  ")
        _font(run, theme.font, 10, bold=True, color=color if tone != "note" else INK)
    _rich(paragraph, text, theme, 10)
    spacer = doc.add_paragraph()
    _spacing_par(spacer, 0, 4)
    spacer.paragraph_format.line_spacing = 0.6
    return tbl


def quote(doc: Document, text: str, source: str | None = None):
    paragraph = doc.add_paragraph(style="Quote")
    paragraph.paragraph_format.left_indent = Inches(0.3)
    paragraph.add_run(text)
    if source:
        run = paragraph.add_run(f"  - {source}")
        run.italic = False
        run.font.size = Pt(9)
    return paragraph


# ------------------------------------------------------------ figures/charts


def figure(doc: Document, image_path: str, width: float | None = None, caption: str | None = None):
    """An image centred on its own line with a caption that stays with it."""
    max_width = _content_width(doc)
    width = min(width or max_width, max_width)
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _spacing_par(paragraph, 4, 0)
    paragraph.paragraph_format.keep_with_next = bool(caption)
    paragraph.add_run().add_picture(str(image_path), width=Inches(width))
    if caption:
        cap = doc.add_paragraph(caption, style="Caption")
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return paragraph


def chart(doc: Document, kind: str, categories: Sequence[str], series: dict[str, Sequence[float]],
          title: str | None = None, caption: str | None = None, width: float | None = None,
          height: float = 2.9, value_format: str = "{:,.0f}", labels: bool = True):
    """A themed chart as a crisp image. kind: bar, hbar, line, stacked, pie."""
    from .charts import render_chart

    theme = _theme(doc)
    base = os.environ.get("TMPDIR") or tempfile.gettempdir()
    fd, path = tempfile.mkstemp(suffix=".png", dir=base)
    os.close(fd)
    max_width = _content_width(doc)
    use = min(width or max_width, max_width)
    render_chart(path, kind, categories, series, theme, use, height, title, value_format, labels)
    return figure(doc, path, use, caption)


# ------------------------------------------------------------------- layout


def page_break(doc: Document) -> None:
    """Start a new page. Prefer letting content flow; use this between major parts only."""
    paragraph = doc.add_paragraph()
    _spacing_par(paragraph, 0, 0)
    paragraph.add_run().add_break(WD_BREAK.PAGE)


def landscape_section(doc: Document) -> None:
    """Switch to landscape from here on (for a wide table)."""
    from docx.enum.section import WD_SECTION

    section = doc.add_section(WD_SECTION.NEW_PAGE)
    if section.orientation != WD_ORIENT.LANDSCAPE:
        section.orientation = WD_ORIENT.LANDSCAPE
        section.page_width, section.page_height = section.page_height, section.page_width


def portrait_section(doc: Document) -> None:
    from docx.enum.section import WD_SECTION

    section = doc.add_section(WD_SECTION.NEW_PAGE)
    if section.orientation != WD_ORIENT.PORTRAIT:
        section.orientation = WD_ORIENT.PORTRAIT
        section.page_width, section.page_height = section.page_height, section.page_width


def contents(doc: Document, entries: Sequence[tuple[str, str]], title: str = "Contents"):
    """A simple contents list from (heading, page-or-note) pairs."""
    theme = _theme(doc)
    paragraph = doc.add_paragraph(title, style="Heading 2")
    width = _content_width(doc)
    for text, where in entries:
        line = doc.add_paragraph()
        _spacing_par(line, 0, 3)
        line.paragraph_format.tab_stops.add_tab_stop(Inches(width), WD_TAB_ALIGNMENT.RIGHT, 1)
        _font(line.add_run(text), theme.font, 10, color=TEXT)
        _font(line.add_run("\t" + where), theme.font, 10, color=MUTED)
    return paragraph


def save(doc: Document, path: str) -> str:
    """Write the file, creating folders as needed."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(target))
    return str(target)
