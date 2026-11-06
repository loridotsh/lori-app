"""Builds one document with every kit and checks the properties that make them good.

    python -m lori_design.selftest

Run in the sandbox image (CI does this). Exits non-zero with a message on the first failure.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
import tempfile
import zipfile
from pathlib import Path


def check(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}")
        sys.exit(1)


def test_formulas() -> None:
    from .formulas import Formulas

    values = {("S", 0, 0): 2.0, ("S", 1, 0): 3.0, ("T", 0, 0): 10.0, ("My Sheet", 4, 1): 7.0}
    f = Formulas(values)
    check(f.evaluate("=A1+A2", "S") == 5.0, "same-sheet arithmetic")
    check(f.evaluate("=SUM(A1:A2)*2", "S") == 10.0, "SUM of a range")
    check(f.evaluate("=T!A1+S!A1", "S") == 12.0, "cross-sheet references")
    check(f.evaluate("='My Sheet'!B5", "S") == 7.0, "quoted sheet names")
    check(f.evaluate("=ROUND(2.345,2)", "S") == 2.35, "ROUND half away from zero")
    check(f.evaluate("=IF(A1>1,10,20)", "S") == 10, "IF")
    check(f.evaluate("=10%*A1", "S") == 0.2, "percent literal")
    check(f.evaluate("=A1/0", "S") is None, "division by zero is unknown, not a crash")
    check(f.evaluate("=VLOOKUP(A1,B1:C2,2)", "S") is None, "unsupported functions are unknown")
    check(f.evaluate("=Z9", "S") is None, "an unwritten cell is unknown")
    check(f.evaluate("=__import__('os')", "S") is None, "no code execution")


def test_docx(directory: Path) -> None:
    from docx import Document
    from docx.oxml.ns import qn

    from .docx_kit import bullets, callout, chart, h1, kpis, new_document, numbered, para, save, table

    doc = new_document("Self test", subtitle="Subtitle", author="Tester", meta="Meta")
    h1(doc, "Heading")
    para(doc, "Body with **bold** and _italic_ and `code`.")
    kpis(doc, [("A", "1", "note"), ("B", "2")])
    callout(doc, "A note", title="Note")
    table(doc, ["Name", "Amount"], [["x", "$1"], ["y", "$2"], ["Total", "$3"]], total_row=True)
    bullets(doc, ["one", ("two", ["nested"])])
    numbered(doc, ["first", "second"])
    numbered(doc, ["again first"])
    chart(doc, "bar", ["a", "b"], {"S": [1, 2]}, title="Chart")
    path = save(doc, str(directory / "t.docx"))
    out = Document(path)
    styles = [p.style.name for p in out.paragraphs]
    check("Title" in styles and "Heading 1" in styles, "real Title and Heading styles")
    check(out.core_properties.title == "Self test", "document title property")
    xml = out.sections[0].footer._element.xml
    check("PAGE" in xml and "NUMPAGES" in xml, "footer has page-number fields")
    header_rows = [r for t in out.tables for r in t.rows if r._tr.trPr is not None and r._tr.trPr.findall(qn("w:tblHeader"))]
    check(len(header_rows) >= 1, "data table header repeats across pages")
    nums = {p._p.pPr.numPr.numId.val for p in out.paragraphs if p.style.name == "List Number" and p._p.pPr.numPr is not None}
    check(len(nums) == 2, "each numbered list has its own counter")
    check(len(out.inline_shapes) == 1, "chart image embedded")


def test_xlsx(directory: Path) -> None:
    from openpyxl import load_workbook

    from .xlsx_kit import Book

    book = Book(str(directory / "t.xlsx"), title="Self test")
    a = book.sheet("A")
    a.title("Sheet A", "units and prices")
    ta = a.table(["Item", "Units", "Price", "Total"], [["x", 2, 5.0, None], ["y", 3, 4.0, None]],
                 formats=["text", "int", "money2", "money"], formulas={3: "={Units}*{Price}"}, total_row=True)
    s = book.sheet("Summary", first=True)
    s.kpis([("Total", "=" + "A!" + ta.total_cell(3), "money")], span=2)
    s.table(["Name", "Value"], [["A", book.ref("A", ta.total_cell(3))]], formats=["text", "money"], total_row=True)
    s.chart("column", s.table(["K", "V"], [["a", 1], ["b", 2]], formats=["text", "int"]), 0, [1])
    book.close()
    cached = load_workbook(directory / "t.xlsx", data_only=True)
    check(cached["A"]["E4"].value == 22 or cached["A"][ta.total_cell(3)].value == 22, "row formulas carry cached values (2*5 + 3*4 = 22)")
    check(cached["Summary"]["B8"].value == 22 or any(c.value == 22 for row in cached["Summary"].iter_rows() for c in row), "cross-sheet totals carry cached values")
    formulas = load_workbook(directory / "t.xlsx")
    check(any(isinstance(c.value, str) and c.value.startswith("=") for row in formulas["A"].iter_rows() for c in row), "formulas stay formulas")
    ws = formulas["A"]
    check(ws.freeze_panes is None, "a short table is not frozen")
    long_book = Book(str(directory / "long.xlsx"))
    sheet = long_book.sheet("Long")
    sheet.table(["N", "Square"], [[i, i * i] for i in range(20)], formats=["int", "int"])
    sheet.table(["N", "Cube"], [[i, i ** 3] for i in range(20)], formats=["int", "int"])
    long_book.close()
    long = load_workbook(directory / "long.xlsx")["Long"]
    check(long.freeze_panes is not None, "a long table's header row is frozen")
    check(ws.sheet_view.showGridLines is False, "gridlines hidden")
    check(ws.auto_filter.ref, "filter on the table")
    check(any(cell.number_format.startswith("$#,##0") for row in ws.iter_rows() for cell in row), "money number format")
    check(formulas.active.title == "Summary", "workbook opens on the summary")
    check(formulas.sheetnames == ["Summary", "A"], "a summary built last is the first tab")
    check(formulas["A"].auto_filter.ref and formulas["Summary"].title == "Summary", "sheet-specific settings stay with their sheet after reordering")

    from .lint import lint_workbook
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    check(lint_workbook(directory / "t.xlsx") == [], "a workbook built with the kit passes the design lint")
    bad = Workbook()
    sheet = bad.active
    sheet.title = "Summary"
    sheet.append(["Region", "unit_price"])
    sheet.append(["EMEA", "=1+1"])
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
    for cell in sheet[4]:
        cell.fill = PatternFill("solid", fgColor="D9EAF7")
    sheet["A4"].fill = sheet["B4"].fill = PatternFill("solid", fgColor="D9EAF7")
    bad.save(directory / "bad.xlsx")
    found = " | ".join(lint_workbook(directory / "bad.xlsx"))
    check("cannot be read" in found and "coloured row" in found and "code name" in found and "no stored result" in found,
          "the lint reports invisible text, an empty coloured row, a code-style title and formulas without results")


def test_pptx(directory: Path) -> None:
    from pptx import Presentation
    from pptx.util import Emu

    from .pptx_kit import Deck

    deck = Deck("Self test")
    deck.title_slide("Self test", "Subtitle", "Meta")
    deck.kpis("Three numbers", [("A", "$1,000", "note"), ("B", "2"), ("C", "3")])
    deck.chart("A chart", "column", ["a", "b"], {"S": [1, 2]}, takeaway="A takeaway.", notes="Say this.")
    deck.table("A table", ["Name", "Amount"], [["x", "$1"], ["y", "$2"]])
    deck.bullets("Bullets", ["one", ("two", ["nested"])])
    deck.section("A section", "note")
    deck.two_column("Two columns", "L", ["a"], "R", ["b"])
    deck.closing("The end", ["line"])
    path = deck.save(str(directory / "t.pptx"))
    check(deck.warnings == [], f"no layout warnings: {deck.warnings}")
    prs = Presentation(path)
    check(len(prs.slides) == 8, "all slides present")
    for number, slide in enumerate(prs.slides, 1):
        check(slide.shapes.title is not None and slide.shapes.title.text_frame.text.strip(), f"slide {number} has a real title")
        for shape in slide.shapes:
            check(shape.left >= 0 and shape.top >= 0 and shape.left + shape.width <= prs.slide_width + 1 and
                  shape.top + shape.height <= prs.slide_height + 1, f"slide {number}: {shape.name} stays on the slide")
    check(prs.slides[2].notes_slide.notes_text_frame.text == "Say this.", "speaker notes")
    check(any(s.has_chart for s in prs.slides[2].shapes), "native chart")
    chart = next(s for s in prs.slides[2].shapes if s.has_chart).chart
    check(chart.plots[0].data_labels.number_format == "#,##0", "whole numbers keep a whole-number label format")
    precise = Deck("Precision")
    precise.chart("Decimals", "column", ["a", "b"], {"S": [3.1, 4.25]})
    precise_path = precise.save(str(directory / "precise.pptx"))
    labels = next(s for s in Presentation(precise_path).slides[0].shapes if s.has_chart).chart.plots[0].data_labels
    check(labels.number_format == "#,##0.00", f"decimal data keeps its precision: {labels.number_format}")
    check(any(s.has_table for s in prs.slides[3].shapes), "native table")


def test_pdf(directory: Path) -> None:
    import pypdf

    from .pdf_kit import Report

    report = Report("Self test", subtitle="Sub & <script>", meta="<b>raw</b> & more")
    report.h1("Heading")
    report.para("Text with **bold**, `code`, & [link](https://example.com) and <angle> brackets.")
    report.kpis([("A", "1", "n"), ("B", "2")])
    report.callout("Note", title="T")
    report.table(["Name", "Amount"], [["x", "$1"]] * 80, total_row=True)
    report.bullets(["a", "b"])
    report.numbered(["a", "b"])
    path = report.build(str(directory / "t.pdf"))
    reader = pypdf.PdfReader(path)
    check(len(reader.pages) >= 2, "a long table breaks across pages")
    text = "\n".join(page.extract_text() for page in reader.pages)
    check("Self test" in text and "<script>" in text and "<angle>" in text, "markup characters are escaped, not interpreted")
    check("Page 1 of" in text, "footer has Page X of Y")
    check(text.count("Name") >= 2, "table header repeats on each page")
    fonts = [f.get_object() for page in reader.pages for f in (page["/Resources"].get("/Font") or {}).values()]
    embedded = []
    for font in fonts:
        descriptor = font.get("/FontDescriptor")
        if descriptor is not None:
            stream = descriptor.get_object().get("/FontFile2")
            if stream is not None:
                embedded.append(stream.get_object().get_data())
    check(any(embedded), "fonts contain actual embedded TrueType data")
    check(reader.metadata.title == "Self test", "PDF title metadata")


def main() -> None:
    os.environ.setdefault("MPLBACKEND", "Agg")
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["TMPDIR"] = tmp
        directory = Path(tmp)
        for name, test in (("formulas", test_formulas), ("docx", test_docx), ("xlsx", test_xlsx), ("pptx", test_pptx), ("pdf", test_pdf)):
            test(directory) if name != "formulas" else test()
            print(f"ok  {name}")
    print("lori_design self-test passed")


if __name__ == "__main__":
    main()
