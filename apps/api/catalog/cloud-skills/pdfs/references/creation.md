# PDF creation with the installed kit

Use a single Word source and convert_document for a DOCX/PDF pair. For a standalone flowing PDF, the installed Report kit supplies embedded fonts, safe text, headings, wrapping tables and pagination. Choose components for the actual genre; there is no mandatory metrics row, chart or callout.

Run this complete builder in one run_command with request-derived data or a declared JSON input. Omit unused elements and use the member's requested output path. Every existing input must be in inputPaths.

```python
from lori_design.theme import document_theme
from lori_design.pdf_kit import Report


def build_pdf(data, output_path):
    theme = document_theme(data.get("palette", "editorial"), data.get("accent"))
    report = Report(data.get("title", ""), subtitle=data.get("subtitle"),
                    author=data.get("author", ""), page=data.get("page", "a4"),
                    theme=theme, footer="", page_numbers=data.get("page_numbers", False))
    if data.get("summary"):
        report.para(data["summary"])
    for section in data.get("sections", []):
        if section.get("heading"):
            report.h1(section["heading"])
        for text in section.get("paragraphs", []):
            report.para(text)
        if section.get("bullets"):
            report.bullets(section["bullets"])
        if section.get("numbered"):
            report.numbered(section["numbered"])
        if section.get("table"):
            t = section["table"]
            report.table(t["headers"], t["rows"], widths=t.get("weights"),
                         align=t.get("align"), caption=t.get("caption"))
        if section.get("source_note"):
            report.para(section["source_note"])
    return report.build(output_path)
```

`data` has optional title, subtitle, summary, author, page (a4/letter), page_numbers and sections. Sections accept heading, paragraphs, bullets, numbered, source_note and table (headers, rectangular rows, relative positive weights, optional l/c/r align and caption). Read actual data then call build_pdf(data, "requested-name.pdf"). For a letter, omit the report title and headings and leave page_numbers false.

## API and extension guidance

- `Report(title,subtitle=None,meta=None,author="Lori",theme=DEFAULT,page="letter",landscape=False,margin=0.9,footer=None,page_numbers=True)`. footer="" omits the running label; page_numbers=False omits numbering too. Use a short label if a running footer helps navigation.
- `h1`, h2, h3, `para(text,align="l")`, `bullets(items)`, `numbered(items)` and `quote(text,source=None)` create flowing text. Pass plain strings; the kit escapes markup and supports **bold**, _italic_, `code` and [descriptive links](https://example.com). Preserve source literals that happen to use these delimiters with direct escaped Paragraphs when necessary.
- `table(headers,rows,widths=None,align=None,total_row=False,zebra=False,caption=None)` wraps cells and repeats headers. widths are relative weights; align has one l/c/r per column. Format actual numbers with correct units/currency first. Long rows can split, but review readability and split/reorganize a dense table when useful.
- `image(path,width=None,caption=None)` fits by page width and height; declare the image in inputPaths. `chart(kind,categories,series,...)` is optional for real comparisons/trends. Use meaningful captions and retain source data.
- `callout(text,title=None,tone="note")` and `kpis(items)` create non-splitting blocks. Use them sparingly and only for short content; long text belongs in normal flowing paragraphs.
- `spacer(points)`, `page_break()` and `build(path)` are available. Avoid repeated manual breaks or spacer padding to reach a page count.
- `money(value,symbol="$",decimals=0)`, `pct(fraction,decimals=1)`, `num(value,decimals=0)` format computed values; choose the source currency.

For a fixed-layout invoice, certificate or form, direct ReportLab is appropriate. Escape external strings in Paragraph markup. The installed fonts have finite character coverage; embedding does not guarantee non-Latin glyphs or complex shaping. Inspect actual rendered text and preserve names, punctuation and language. Do not silently strip characters or promise PDF/UA/PDF/A from appearance alone. Read back the exact final file and inspect every rendered page; see the verification reference.

## Colour roles for new documents

Choose `palette`: `editorial` (deep teal), `mineral` (slate blue), `terracotta` (warm earth), or `monochrome` (formal neutral). An optional six-digit `accent` overrides the brand fill. `document_theme` retains that fill and derives readable heading/link tones. Table text uses a contrasting foreground. Use one palette throughout the deliverable; use monochrome where the genre calls for it. Supplied templates remain authoritative. Inspect the actual PDF export and final rendered colours, including table headings, links and figures; a correct DOCX colour value does not prove the export.
