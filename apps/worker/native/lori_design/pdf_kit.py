"""PDF reports that look typeset: real fonts, a footer with page numbers, tables that break cleanly.

    from lori_design.pdf_kit import Report
    report = Report("Q3 operations review", subtitle="Regional performance", meta="October 2026")
    report.h1("Executive summary")
    report.para("Combined sales reached **$501,560**. See [the dataset](https://example.com).")
    report.kpis([("Combined sales", "$501,560", "USD"), ("Units", "3,145", "60 records")])
    report.table(["Region", "Sales"], [["EMEA", "$154,965"]], total_row=False)
    report.build("report.pdf")

Text is XML-escaped for you (a "<" or "&" in your data cannot break layout) and supports
**bold**, _italic_, `code` and [links](https://...). A complete managed font family is embedded, so
supported accents and symbols render. Font coverage and shaping still need to
be checked for the actual language. Never pass raw markup from untrusted text.
"""
from __future__ import annotations

import os
import re
import tempfile
from math import isfinite
from pathlib import Path
from typing import Iterable, Sequence
from urllib.parse import urlsplit

import reportlab

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether, ListFlowable, ListItem, LongTable,
                                PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle)

from .theme import DEFAULT, HAIR, INK, MUTED, RULE, SURFACE, TEXT, WHITE, Theme, on_color, tint

__all__ = ["Report", "esc", "rich", "money", "pct", "num"]

_FONT_DIRS = ("/usr/share/fonts/truetype/liberation", "/usr/share/fonts/truetype/liberation2",
              "/usr/share/fonts/truetype/dejavu", str(Path(reportlab.__file__).parent / "fonts"))
_REGISTERED = False


def _register_fonts() -> tuple[str, str, str, str]:
    global _REGISTERED
    names = ("Body", "Body-Bold", "Body-Italic", "Body-BoldItalic")
    if _REGISTERED:
        return names
    families = (("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"),
                ("LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "LiberationSans-Italic.ttf", "LiberationSans-BoldItalic.ttf"),
                ("Vera.ttf", "VeraBd.ttf", "VeraIt.ttf", "VeraBI.ttf"))
    paths = next(([Path(d) / f for f in family] for family in families for d in _FONT_DIRS
                  if all((Path(d) / f).is_file() for f in family)), None)
    if paths is None:
        raise RuntimeError("No complete bundled PDF font family is available")
    for name, path in zip(names, paths):
        pdfmetrics.registerFont(TTFont(name, path))
    pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body-Italic", boldItalic="Body-BoldItalic")
    mono = next((Path(d) / f for f in ("DejaVuSansMono.ttf", "LiberationMono-Regular.ttf") for d in _FONT_DIRS
                 if (Path(d) / f).is_file()), paths[0])
    pdfmetrics.registerFont(TTFont("Body-Mono", mono))
    pdfmetrics.registerFontFamily("Body-Mono", normal="Body-Mono", bold="Body-Mono", italic="Body-Mono", boldItalic="Body-Mono")
    _REGISTERED = True
    return names


def esc(text: object, font: str = "Body") -> str:
    """Escape literal text, rejecting glyphs the selected embedded font lacks."""
    _register_fonts()
    value = str(text)
    coverage = pdfmetrics.getFont(font).face.charToGlyph
    missing = sorted({ch for ch in value if not ch.isspace() and ord(ch) not in coverage})
    if missing:
        raise ValueError("PDF font lacks these characters; use a supported font/shaping route or convert the authoring source: " + repr("".join(missing)))
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_INLINE = re.compile(r"(\*\*.+?\*\*|`.+?`|\[[^\]]+\]\([^)\s]+\)|(?<![\w])_.+?_(?![\w]))")


def rich(text: object, link_color: str = "1E3A5F") -> str:
    """**bold**, _italic_, `code` and [text](url) to safe Paragraph markup."""
    out = []
    for part in _INLINE.split(str(text)):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            out.append(f"<b>{esc(part[2:-2])}</b>")
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            out.append(f'<font name="Body-Mono" size="9">{esc(part[1:-1], "Body-Mono")}</font>')
        elif part.startswith("[") and "](" in part and part.endswith(")"):
            label, url = part[1:].rsplit("](", 1)
            target = url[:-1]
            try:
                scheme = urlsplit(target).scheme.lower()
            except ValueError:
                scheme = ""
            if scheme in ("http", "https", "mailto"):
                safe = target.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")
                out.append(f'<a href="{safe}" color="#{link_color}"><u>{esc(label)}</u></a>')
            else:
                out.append(esc(label))
        elif part.startswith("_") and part.endswith("_") and len(part) > 2:
            out.append(f"<i>{esc(part[1:-1])}</i>")
        else:
            out.append(esc(part))
    return "".join(out)


def money(value: float, symbol: str = "$", decimals: int = 0) -> str:
    text = f"{symbol}{abs(value):,.{decimals}f}"
    return f"({text})" if value < 0 else text


def pct(value: float, decimals: int = 1) -> str:
    return f"{value * 100:,.{decimals}f}%"


def num(value: float, decimals: int = 0) -> str:
    return f"{value:,.{decimals}f}"


class _Numbered(rl_canvas.Canvas):
    """Draws 'Page X of Y' by counting pages first."""

    footer_left = ""
    footer_font = "Helvetica"
    margin = 0.9 * inch
    page_numbers = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved: list[dict] = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._footer(total)
            super().showPage()
        super().save()

    def _footer(self, total: int) -> None:
        width, _ = self._pagesize
        self.setFont(self.footer_font, 8)
        self.setFillColor(colors.HexColor(f"#{MUTED}"))
        page_label = f"Page {self._pageNumber} of {total}" if self.page_numbers else ""
        # Reserve the page label before fitting a potentially long running title.
        available = width - 2 * self.margin - (self.stringWidth(page_label, self.footer_font, 8) + 18 if page_label else 0)
        label = self.footer_left
        if self.stringWidth(label, self.footer_font, 8) > available:
            while label and self.stringWidth(label + "...", self.footer_font, 8) > available:
                label = label[:-1]
            label += "..."
        self.drawString(self.margin, 0.5 * inch, label)
        if page_label:
            self.drawRightString(width - self.margin, 0.5 * inch, page_label)


class Report:
    def __init__(self, title: str, subtitle: str | None = None, meta: str | None = None, author: str = "Lori",
                 theme: Theme = DEFAULT, page: str = "letter", landscape: bool = False, margin: float = 0.9,
                 footer: str | None = None, page_numbers: bool = True):
        self.theme = theme
        self.title, self.subtitle, self.meta = title, subtitle, meta
        self.author = author
        size = A4 if page.lower() == "a4" else letter
        self.pagesize = (size[1], size[0]) if landscape else size
        self.margin = margin * inch
        self.footer = title if footer is None else footer
        self.page_numbers = page_numbers
        regular, bold, italic, bold_italic = _register_fonts()
        esc(self.footer)  # Footer canvas text needs the same coverage check as body text.
        self.fonts = (regular, bold, italic, bold_italic)
        self.story: list = []
        self.styles = self._styles()
        self.width = self.pagesize[0] - 2 * self.margin
        if title:
            self._title_block()

    # ----------------------------------------------------------------- styles
    def _styles(self) -> dict[str, ParagraphStyle]:
        regular, bold, italic, _ = self.fonts
        accent = colors.HexColor(f"#{self.theme.readable_accent}")
        base = dict(fontName=regular, textColor=colors.HexColor(f"#{TEXT}"), leading=15, fontSize=10.5)
        return {
            "title": ParagraphStyle("title", fontName=bold, fontSize=27, leading=31, textColor=colors.HexColor(f"#{INK}"), spaceAfter=4),
            "subtitle": ParagraphStyle("subtitle", fontName=regular, fontSize=13, leading=17, textColor=colors.HexColor(f"#{MUTED}"), spaceAfter=6),
            "meta": ParagraphStyle("meta", fontName=regular, fontSize=9, leading=12, textColor=colors.HexColor(f"#{MUTED}"), spaceAfter=18),
            "h1": ParagraphStyle("h1", fontName=bold, fontSize=17, leading=21, textColor=colors.HexColor(f"#{self.theme.heading_ink}"), spaceBefore=20, spaceAfter=7, keepWithNext=True),
            "h2": ParagraphStyle("h2", fontName=bold, fontSize=13, leading=17, textColor=accent, spaceBefore=14, spaceAfter=5, keepWithNext=True),
            "h3": ParagraphStyle("h3", fontName=bold, fontSize=11, leading=14, spaceBefore=10, spaceAfter=3, keepWithNext=True,
                                 textColor=colors.HexColor(f"#{TEXT}")),
            "body": ParagraphStyle("body", spaceAfter=7, **base),
            "bullet": ParagraphStyle("bullet", spaceAfter=3, **base),
            "small": ParagraphStyle("small", fontName=regular, fontSize=8.5, leading=11, textColor=colors.HexColor(f"#{MUTED}")),
            "caption": ParagraphStyle("caption", fontName=regular, fontSize=8.5, leading=11, textColor=colors.HexColor(f"#{MUTED}"),
                                      alignment=TA_CENTER, spaceBefore=3, spaceAfter=12),
            "cell": ParagraphStyle("cell", fontName=regular, fontSize=9.5, leading=12, textColor=colors.HexColor(f"#{TEXT}")),
            "quote": ParagraphStyle("quote", fontName=italic, fontSize=11, leading=16, textColor=colors.HexColor(f"#{MUTED}"),
                                    leftIndent=14, spaceBefore=6, spaceAfter=10),
        }

    def _title_block(self) -> None:
        self.story.append(Paragraph(rich(self.title), self.styles["title"]))
        if self.subtitle:
            self.story.append(Paragraph(rich(self.subtitle), self.styles["subtitle"]))
        if self.meta:
            self.story.append(Paragraph(rich(self.meta), self.styles["meta"]))
        elif self.subtitle:
            self.story.append(Spacer(1, 8))

    # ---------------------------------------------------------------- content
    def h1(self, text: str) -> None:
        self.story.append(Paragraph(rich(text), self.styles["h1"]))

    def h2(self, text: str) -> None:
        self.story.append(Paragraph(rich(text), self.styles["h2"]))

    def h3(self, text: str) -> None:
        self.story.append(Paragraph(rich(text), self.styles["h3"]))

    def para(self, text: str, align: str = "l") -> None:
        style = self.styles["body"]
        if align != "l":
            style = ParagraphStyle("aligned", parent=style, alignment={"c": TA_CENTER, "r": TA_RIGHT}.get(align, TA_LEFT))
        self.story.append(Paragraph(rich(text, self.theme.readable_accent), style))

    def spacer(self, points: float = 10) -> None:
        self.story.append(Spacer(1, points))

    def bullets(self, items: Iterable[str]) -> None:
        self._list(items, "bullet")

    def numbered(self, items: Iterable[str]) -> None:
        self._list(items, "1")

    def _list(self, items: Iterable[str], kind: str) -> None:
        flow = ListFlowable(
            [ListItem(Paragraph(rich(item, self.theme.readable_accent), self.styles["bullet"]), leftIndent=16) for item in items],
            bulletType="bullet" if kind == "bullet" else "1", bulletFontName=self.fonts[0], bulletFontSize=9 if kind == "bullet" else 10,
            bulletColor=colors.HexColor(f"#{MUTED}"), leftIndent=16, start="•" if kind == "bullet" else 1,
            bulletFormat=None if kind == "bullet" else "%s.",
        )
        self.story.append(flow)
        self.story.append(Spacer(1, 6))

    def quote(self, text: str, source: str | None = None) -> None:
        self.story.append(Paragraph(rich(text) + (f"  <font size=9>- {esc(source)}</font>" if source else ""), self.styles["quote"]))

    def callout(self, text: str, title: str | None = None, tone: str = "note") -> None:
        from .theme import NEGATIVE, POSITIVE, WARNING

        color = {"note": self.theme.accent, "positive": POSITIVE, "warning": WARNING, "risk": NEGATIVE}.get(tone, self.theme.accent)
        label = f"<b>{esc(title)}</b>  " if title else ""
        cell = Paragraph(label + rich(text, color), ParagraphStyle("callout", parent=self.styles["body"], fontSize=10, spaceAfter=0))
        table = Table([[cell]], colWidths=[self.width])
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(f"#{tint(color, 0.93)}")),
            ("LINEBEFORE", (0, 0), (0, -1), 3, colors.HexColor(f"#{color}")),
            ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        self.story.append(KeepTogether([table, Spacer(1, 10)]))

    def kpis(self, items: Sequence[tuple[str, str] | tuple[str, str, str]]) -> None:
        """A row of headline numbers: (label, value) or (label, value, note)."""
        regular, bold, _, _ = self.fonts
        gap = 8
        column = (self.width - gap * (len(items) - 1)) / len(items)
        cells = []
        for item in items:
            label, value = item[0], item[1]
            note = item[2] if len(item) > 2 else ""
            inner = [
                Paragraph(f"<font size=7 color='#{MUTED}'><b>{esc(label.upper())}</b></font>", ParagraphStyle("k1", fontName=regular, leading=9, spaceAfter=3)),
                Paragraph(f"<font size=20 color='#{INK}'><b>{esc(value)}</b></font>", ParagraphStyle("k2", fontName=bold, leading=23)),
            ]
            if note:
                inner.append(Paragraph(f"<font size=8.5 color='#{MUTED}'>{esc(note)}</font>", ParagraphStyle("k3", fontName=regular, leading=11, spaceBefore=2)))
            cells.append(inner)
        widths = []
        row = []
        for i, content in enumerate(cells):
            row.append(content)
            widths.append(column)
            if i < len(cells) - 1:
                row.append("")
                widths.append(gap)
        table = Table([row], colWidths=widths)
        style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                 ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9)]
        for i in range(0, len(row), 2):
            style += [("BACKGROUND", (i, 0), (i, 0), colors.HexColor(f"#{SURFACE}")),
                      ("LINEABOVE", (i, 0), (i, 0), 2.25, colors.HexColor(f"#{self.theme.accent}"))]
        table.setStyle(TableStyle(style))
        self.story.append(KeepTogether([table, Spacer(1, 12)]))

    def table(self, headers: Sequence[str], rows: Sequence[Sequence[object]], widths: Sequence[float] | None = None,
              align: str | None = None, total_row: bool = False, zebra: bool = False, caption: str | None = None) -> None:
        """A table with a repeating dark header, hairline rows and right-aligned numbers.

        Cells wrap, so long text is fine. `widths` are relative weights. `align` is one of l, c, r per column.
        """
        regular, bold, _, _ = self.fonts
        columns = len(headers)
        weights = list(widths) if widths is not None else [1.0] * columns
        if (not columns or len(weights) != columns or
                any(not isfinite(w) or w <= 0 for w in weights) or
                any(len(row) > columns for row in rows)):
            raise ValueError("Tables require headers, positive column widths and rows with no extra columns")
        scale = self.width / sum(weights)
        col_widths = [w * scale for w in weights]
        numeric = re.compile(r"^[\s$€£(−-]*[\d.,]+[)%xKMB]*$")
        aligns = list(align) if align else ["r" if rows and all(numeric.match(str(r[i])) for r in rows if i < len(r)) else "l" for i in range(columns)]
        alignment = {"l": TA_LEFT, "c": TA_CENTER, "r": TA_RIGHT}
        if len(aligns) != columns or any(a not in alignment for a in aligns):
            raise ValueError("Table align must contain one l/c/r character per column")
        head_color = f"#{on_color(self.theme.accent)}"
        data = [[Paragraph(f"<b>{esc(h)}</b>", ParagraphStyle(f"h{i}", parent=self.styles["cell"], textColor=colors.HexColor(head_color),
                                                              alignment=alignment[aligns[i]], fontName=bold)) for i, h in enumerate(headers)]]
        last = len(rows) - 1
        for r, row in enumerate(rows):
            is_total = total_row and r == last
            data.append([Paragraph(rich("" if (i >= len(row) or row[i] is None) else row[i], self.theme.readable_accent),
                                   ParagraphStyle(f"c{r}{i}", parent=self.styles["cell"], alignment=alignment[aligns[i]],
                                                  fontName=bold if is_total else regular,
                                                  textColor=colors.HexColor(f"#{INK if is_total else TEXT}")))
                         for i in range(columns)])
        table = LongTable(data, colWidths=col_widths, repeatRows=1, splitByRow=1, splitInRow=1)
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(f"#{self.theme.accent}")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LINEBELOW", (0, 1), (-1, -1), 0.5, colors.HexColor(f"#{HAIR}")),
            ("LINEBELOW", (0, -1), (-1, -1), 1.5, colors.HexColor(f"#{INK}")),
        ]
        if zebra:
            for r in range(2, len(data), 2):
                style.append(("BACKGROUND", (0, r), (-1, r), colors.HexColor(f"#{SURFACE}")))
        if total_row and rows:
            style.append(("LINEABOVE", (0, -1), (-1, -1), 1, colors.HexColor(f"#{INK}")))
        table.setStyle(TableStyle(style))
        self.story.append(table)
        self.story.append(Paragraph(rich(caption), self.styles["caption"]) if caption else Spacer(1, 10))

    def image(self, path: str, width: float | None = None, caption: str | None = None) -> None:
        from PIL import Image as PILImage

        with PILImage.open(path) as img:
            ratio = img.height / img.width
        # Fit portrait images by height too; a width-only fit can exceed a page.
        following = [Paragraph(rich(caption), self.styles["caption"])] if caption else [Spacer(1, 8)]
        reserved = sum(flow.wrap(self.width, self.pagesize[1])[1] + flow.getSpaceBefore() + flow.getSpaceAfter()
                       for flow in following)
        max_height = self.pagesize[1] - self.margin * 1.9 - reserved - 1
        if max_height <= 0:
            raise ValueError("Image caption exceeds a page; use flowing body text instead")
        use = min(width * inch if width else self.width, self.width, max_height / ratio)
        picture = Image(path, width=use, height=use * ratio)
        picture.hAlign = "CENTER"
        block = [picture, *following]
        self.story.append(KeepTogether(block))

    def chart(self, kind: str, categories: Sequence[str], series: dict[str, Sequence[float]], title: str | None = None,
              caption: str | None = None, height: float = 2.9, value_format: str = "{:,.0f}", labels: bool = True) -> None:
        """A themed chart (bar, hbar, line, stacked, pie) as a sharp image."""
        from .charts import render_chart

        fd, path = tempfile.mkstemp(suffix=".png", dir=os.environ.get("TMPDIR") or tempfile.gettempdir())
        os.close(fd)
        render_chart(path, kind, categories, series, self.theme, self.width / inch, height, title, value_format, labels)
        self.image(path, self.width / inch, caption)

    def page_break(self) -> None:
        self.story.append(PageBreak())

    # ------------------------------------------------------------------ build
    def build(self, path: str | Path) -> str:
        path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        doc = BaseDocTemplate(path, pagesize=self.pagesize, leftMargin=self.margin, rightMargin=self.margin,
                              topMargin=self.margin * 0.9, bottomMargin=self.margin * 1.0,
                              title=self.title, author=self.author, subject=self.subtitle or "", creator="Lori")
        frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        doc.addPageTemplates([PageTemplate(id="page", frames=[frame])])
        footer_left, font = self.footer, self.fonts[0]

        class Numbered(_Numbered):
            pass

        Numbered.footer_left = footer_left
        Numbered.footer_font = font
        Numbered.margin = self.margin
        Numbered.page_numbers = self.page_numbers
        doc.build(self.story, canvasmaker=Numbered)
        return path
