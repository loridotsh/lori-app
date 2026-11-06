"""Request-shaped recipe and layout regressions for the installed Word/PDF kit.

Run with the managed Python and PYTHONPATH=apps/worker/native. No user files,
network, provider credentials or live services are used.
"""
from pathlib import Path
import os
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

from docx import Document
from pypdf import PdfReader
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from lori_design import pdf_kit
from lori_design.docx_kit import new_document, table, save

CATALOG = Path(os.environ["LORI_CLOUD_SKILLS_ROOT"]) if "LORI_CLOUD_SKILLS_ROOT" in os.environ else Path(__file__).resolve().parents[2] / "api/catalog/cloud-skills"


def load_recipe(skill, reference, function):
    source = (CATALOG / skill / "references" / reference).read_text()
    for block in re.findall(r"```python\n(.*?)\n```", source, re.S):
        namespace = {}
        exec(compile(block, str(CATALOG / skill / reference), "exec"), namespace)
        if function in namespace:
            return namespace[function]
    raise AssertionError("Recipe function not found: " + function)


class DocumentLayoutTests(unittest.TestCase):
    def test_document_palettes_have_readable_roles_and_keep_other_defaults(self):
        from lori_design.theme import DOCUMENT_PALETTES, DEFAULT, INK, Theme, WHITE, contrast, document_theme
        self.assertEqual(DEFAULT.heading_ink, INK)
        self.assertEqual(Theme().accent, "1E3A5F")
        for name, accent in DOCUMENT_PALETTES.items():
            theme = document_theme(name)
            self.assertEqual(theme.accent, accent)
            self.assertGreaterEqual(contrast(theme.heading_ink, WHITE), 4.5)
            self.assertGreaterEqual(contrast(theme.on_accent, accent), 4.5)
        light = document_theme(accent="#FFD400")
        self.assertEqual(light.accent, "FFD400")
        self.assertGreaterEqual(contrast(light.readable_accent, WHITE), 4.5)
        self.assertGreaterEqual(contrast(light.on_accent, light.accent), 4.5)
        for accent in [f"{value:02X}" * 3 for value in range(256)] + ["FF0000", "00FF00", "0000FF"]:
            with self.subTest(accent=accent):
                theme = document_theme(accent=accent)
                self.assertGreaterEqual(contrast(theme.on_accent, accent), 4.5)
        for kwargs in ({"palette": "unknown"}, {"accent": "##123456"}, {"accent": "bad"}):
            with self.assertRaises(ValueError):
                document_theme(**kwargs)

    def test_brand_reaches_saved_word_and_pdf_without_theme_overrides(self):
        from docx.oxml.ns import qn
        from lori_design.theme import document_theme
        from lori_design.docx_kit import _font
        from docx.enum.dml import MSO_THEME_COLOR_INDEX
        for name, accent in [("editorial", "0E5B60"), ("terracotta", "874A35")]:
            data = {"title": "Project proposal", "palette": name, "sections": [{"heading": "Scope", "table": {"headers": ["Item", "Owner"], "rows": [["Review", "Advisory"]]}}]}
            doc = Document(load_recipe("documents", "creation.md", "build_document")(data, self.root / (name + ".docx")))
            self.assertEqual(str(doc.styles["Heading 1"].font.color.rgb), accent)
            self.assertEqual(doc.tables[0].cell(0,0)._tc.tcPr.find(qn("w:shd")).get(qn("w:fill")), accent)
            page = PdfReader(load_recipe("pdfs", "creation.md", "build_pdf")(data, self.root / (name + ".pdf"))).pages[0]
            paints = [tuple(float(v) for v in values) for values, op in page.get_contents().operations if op == b"rg"]
            expected = tuple(int(accent[i:i+2], 16) / 255 for i in (0,2,4))
            self.assertTrue(any(all(abs(a-b) < .00001 for a,b in zip(paint, expected)) for paint in paints))
        style = doc.styles["Heading 1"]
        style.font.color.theme_color = MSO_THEME_COLOR_INDEX.ACCENT_1
        style.element.rPr.color.set(qn("w:themeTint"), "AA")
        _font(style, "Arial", color="0E5B60")
        self.assertNotIn("themeColor", style.element.xml)
        self.assertNotIn("themeTint", style.element.xml)
        self.assertEqual(str(style.font.color.rgb), "0E5B60")

    def test_mid_tone_brand_headers_keep_contrast_in_saved_word_and_pdf(self):
        from docx.oxml.ns import qn
        for accent in ("777777", "808080", "FF0000"):
            with self.subTest(accent=accent):
                data = {"accent": accent, "sections": [{"table": {"headers": ["Status"], "rows": [["Review"]]}}]}
                doc = Document(load_recipe("documents", "creation.md", "build_document")(data, self.root / (accent + ".docx")))
                cell = doc.tables[0].cell(0, 0)
                runs = [run for run in cell.paragraphs[0].runs if run.text]
                self.assertTrue(runs)
                self.assertTrue(all(str(run.font.color.rgb) == "000000" for run in runs))
                self.assertEqual(cell._tc.tcPr.find(qn("w:shd")).get(qn("w:fill")), accent)
                page = PdfReader(load_recipe("pdfs", "creation.md", "build_pdf")(data, self.root / (accent + ".pdf"))).pages[0]
                paints = [tuple(float(v) for v in values) for values, op in page.get_contents().operations if op == b"rg"]
                self.assertIn((0., 0., 0.), paints)
                self.assertIn("Status", page.extract_text())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Font aliases are global in ReportLab. Do not let a forced fallback in
        # one test change the font family used by subsequent cases.
        for registry in (pdfmetrics._fonts, pdfmetrics._dynFaceNames):
            guard = patch.dict(registry)
            guard.start()
            self.addCleanup(guard.stop)
        for name in ("Body", "Body-Bold", "Body-Italic", "Body-BoldItalic", "Body-Mono"):
            pdfmetrics._fonts.pop(name, None)
        pdfmetrics._dynFaceNames.clear()
        pdf_kit._REGISTERED = False
        self.addCleanup(setattr, pdf_kit, "_REGISTERED", False)

    def test_pdf_inline_code_works_with_only_bundled_fonts(self):
        import reportlab
        bundled = str(Path(reportlab.__file__).parent / "fonts")
        with patch.object(pdf_kit, "_FONT_DIRS", (bundled,)), patch.object(pdf_kit, "_REGISTERED", False):
            report = pdf_kit.Report("Code values")
            report.para("Retain `order_id` and A < B & C > D.")
            report.build(str(self.root / "code.pdf"))
        text = PdfReader(self.root / "code.pdf").pages[0].extract_text()
        self.assertIn("order_id", text)
        self.assertIn("A < B & C > D", text)

    def test_pdf_tall_table_row_flows_and_retains_final_content(self):
        report = pdf_kit.Report("Evidence register")
        report.table(["Record", "Details"], [["A", "Long evidence paragraph. " * 700 + "END OF EVIDENCE"]], widths=[1, 4])
        report.build(str(self.root / "tall.pdf"))
        reader = PdfReader(self.root / "tall.pdf")
        self.assertGreater(len(reader.pages), 1)
        self.assertIn("END OF EVIDENCE", reader.pages[-1].extract_text())
        for page in reader.pages:
            self.assertIn("Details", page.extract_text())

    def test_unsupported_glyphs_fail_before_a_broken_pdf_is_saved(self):
        with self.assertRaisesRegex(ValueError, "font lacks"):
            pdf_kit.Report("日本語").build(str(self.root / "missing.pdf"))
        self.assertFalse((self.root / "missing.pdf").exists())

    def test_runtime_font_covers_currency_and_greek_text(self):
        # The real Linux runtime has DejaVu. Use the managed desktop font asset
        # for this test when running outside the container.
        directories = pdf_kit._FONT_DIRS
        local = Path(sys.executable).resolve().parents[2] / "office/Contents/Resources/fonts/truetype"
        if local.is_dir():
            directories = (str(local), *directories)
        with patch.object(pdf_kit, "_FONT_DIRS", directories):
            report = pdf_kit.Report("Budget ₹100")
            report.para("Units α; amount `₹100`.")
            report.build(str(self.root / "currency.pdf"))
        text = PdfReader(self.root / "currency.pdf").pages[0].extract_text()
        self.assertIn("₹100", text)
        self.assertIn("α", text)

    def test_word_column_geometry_matches_requested_proportions(self):
        doc = new_document("Evidence register")
        table(doc, ["Record", "Details"], [["A", "Wide description"]], widths=[1, 4])
        saved = Document(save(doc, str(self.root / "report.docx")))
        tbl = saved.tables[0]
        self.assertAlmostEqual(tbl.columns[1].width / tbl.columns[0].width, 4, places=2)
        self.assertAlmostEqual(tbl.rows[0].cells[1].width / tbl.rows[0].cells[0].width, 4, places=2)
        self.assertEqual(len(tbl._tbl.tblPr.findall("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblLayout")), 1)
        self.assertTrue(saved.styles["Title"].paragraph_format.keep_with_next)
        self.assertTrue(saved.styles["Subtitle"].paragraph_format.keep_with_next)
        self.assertNotIn("Evidence register", saved.sections[0].footer._element.xml)

    def test_ragged_tables_do_not_silently_drop_values(self):
        for build in (lambda: table(new_document(), ["A"], [["one", "lost"]]),
                      lambda: pdf_kit.Report("").table(["A"], [["one", "lost"]])):
            with self.assertRaisesRegex(ValueError, "extra columns"):
                build()

    def test_omitted_trailing_table_cells_remain_supported(self):
        doc = new_document("Sparse table")
        table(doc, ["Name", "Note"], [["Evidence"]])
        saved = Document(save(doc, str(self.root / "sparse.docx")))
        self.assertEqual(saved.tables[0].rows[1].cells[1].text, "")
        report = pdf_kit.Report("Sparse table")
        report.table(["Name", "Note"], [["Evidence"]])
        report.build(str(self.root / "sparse.pdf"))
        self.assertIn("Evidence", PdfReader(self.root / "sparse.pdf").pages[0].extract_text())

    def test_literal_link_parameters_and_safe_label_survive(self):
        report = pdf_kit.Report("Sources")
        report.para('[Evidence](https://example.com/search?a=1&b=2) and [label](javascript:alert)')
        report.build(str(self.root / "links.pdf"))
        page = PdfReader(self.root / "links.pdf").pages[0]
        links = [a.get_object()["/A"]["/URI"] for a in page.get("/Annots", [])]
        self.assertEqual(links, ["https://example.com/search?a=1&b=2"])
        self.assertIn("label", page.extract_text())

    def test_footer_label_fits_before_page_number(self):
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfgen.canvas import Canvas
        drawn = []
        original = Canvas.drawString

        def record(canvas, x, y, text, *args, **kwargs):
            drawn.append((x, y, text, canvas._fontname, canvas._fontsize))
            return original(canvas, x, y, text, *args, **kwargs)

        report = pdf_kit.Report("A long document title " * 40)
        report.para("Body.")
        with patch.object(Canvas, "drawString", record):
            report.build(str(self.root / "footer.pdf"))
        footer = next(d for d in drawn if d[1] == 36 and d[0] == report.margin)
        page_label = "Page 1 of 1"
        label_right = footer[0] + pdfmetrics.stringWidth(footer[2], footer[3], footer[4])
        number_left = report.pagesize[0] - report.margin - pdfmetrics.stringWidth(page_label, report.fonts[0], 8)
        self.assertLess(label_right, number_left)

    def test_tall_image_fits_without_overflow(self):
        from PIL import Image
        image = self.root / "portrait.png"
        Image.new("RGB", (100, 2000), "white").save(image)
        report = pdf_kit.Report("")
        report.image(str(image), caption="Portrait evidence")
        report.build(str(self.root / "image.pdf"))
        reader = PdfReader(self.root / "image.pdf")
        self.assertEqual(len(reader.pages), 1)
        self.assertIn("Portrait evidence", reader.pages[0].extract_text())

    def test_tall_image_reserves_the_actual_wrapped_caption_height(self):
        from PIL import Image
        image = self.root / "portrait-caption.png"
        Image.new("RGB", (100, 2000), "white").save(image)
        report = pdf_kit.Report("")
        caption = "Evidence preserved from the source record. " * 40 + "END OF CAPTION"
        report.image(str(image), caption=caption)
        report.build(str(self.root / "caption.pdf"))
        reader = PdfReader(self.root / "caption.pdf")
        self.assertEqual(len(reader.pages), 1)
        self.assertIn("END OF CAPTION", reader.pages[0].extract_text())

    def test_creation_recipes_keep_a_letter_simple(self):
        data = {"sections": [{"paragraphs": ["Dear André,", "Please confirm receipt.", "Thank you."]}]}
        word = load_recipe("documents", "creation.md", "build_document")(data, str(self.root / "letter.docx"))
        pdf = load_recipe("pdfs", "creation.md", "build_pdf")(data, str(self.root / "letter.pdf"))
        doc = Document(word)
        self.assertEqual([p.text for p in doc.paragraphs], data["sections"][0]["paragraphs"])
        self.assertNotIn("PAGE", doc.sections[0].footer._element.xml)
        reader = PdfReader(pdf)
        self.assertEqual(len(reader.pages), 1)
        self.assertNotIn("Page 1", reader.pages[0].extract_text())
        self.assertNotIn("Executive summary", reader.pages[0].extract_text())

    def test_form_recipe_fills_stored_fields_on_every_page(self):
        source = self.root / "source.pdf"
        c = canvas.Canvas(str(source))
        c.drawString(72, 750, "First page")
        c.acroForm.textfield(name="Name", x=72, y=700, width=240, height=24)
        c.showPage()
        c.drawString(72, 750, "Second page")
        c.acroForm.textfield(name="Reference", x=72, y=700, width=240, height=24)
        c.save()
        fill = load_recipe("pdfs", "editing.md", "fill_form")
        target = self.root / "filled.pdf"
        fill(str(source), str(target), {"Name": "Ada Lovelace", "Reference": "Second page value"})
        reader = PdfReader(target)
        self.assertEqual(reader.get_fields()["Reference"]["/V"], "Second page value")
        # Interactive values live in widget appearances, not page text streams.
        widgets = [a.get_object() for a in reader.pages[1]["/Annots"]]
        self.assertTrue(any(b"Second page value" in a["/AP"]["/N"].get_object().get_data() for a in widgets))
        self.assertEqual(len(PdfReader(source).get_fields()), 2)
        self.assertEqual(PdfReader(source).get_fields()["Reference"]["/V"], "")


if __name__ == "__main__":
    unittest.main()
