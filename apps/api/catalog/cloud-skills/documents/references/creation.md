# Word creation with the installed kit

Start with the actual content and document type. Use the kit's typography, semantic styles and table mechanics; select components deliberately rather than copying a sample business report. Preserve supplied templates with python-docx instead of applying this baseline over them.

This complete builder accepts data from the request or a declared JSON input. Run it in one run_command; declare existing input files in inputPaths. Supply a meaningful requested output path. Do not leave template instructions or Markdown syntax in literal text.

```python
from lori_design.theme import document_theme
from lori_design.docx_kit import new_document, h1, para, bullets, numbered, table, save


def build_document(data, output_path):
    theme = document_theme(data.get("palette", "editorial"), data.get("accent"))
    doc = new_document(data.get("title"), subtitle=data.get("subtitle"),
                       author=data.get("author", ""), page=data.get("page", "a4"),
                       theme=theme, footer=data.get("page_numbers", False), footer_text="", body_size=11)
    if data.get("summary"):
        para(doc, data["summary"])
    for section in data.get("sections", []):
        if section.get("heading"):
            h1(doc, section["heading"])
        for text in section.get("paragraphs", []):
            para(doc, text)
        if section.get("bullets"):
            bullets(doc, section["bullets"])
        if section.get("numbered"):
            numbered(doc, section["numbered"])
        if section.get("table"):
            t = section["table"]
            table(doc, t["headers"], t["rows"], widths=t.get("weights"),
                  align=t.get("align"), caption=t.get("caption"))
        if section.get("source_note"):
            doc.add_paragraph(section["source_note"], "Caption")
    return save(doc, output_path)
```

`data` has optional title, subtitle, author, summary, page (a4/letter), page_numbers and sections. Sections accept heading, paragraphs, bullets, numbered, source_note and table (headers, rectangular rows, relative positive weights, optional align with l/c/r per column and caption). Omit unused elements. Read the actual input, then call build_document(data, "requested-name.docx"). Never invent an author or turn an example into source data.

## Kit API and choices

- `new_document(title=None, subtitle=None, author="", theme=DEFAULT, page="letter", margins=1.0, landscape=False, footer=True, footer_text=None, header_text=None, body_size=10.5, meta=None)` returns a python-docx Document. Use footer=False for an ordinary letter; footer_text="" gives page numbers alone. meta is optional factual metadata, not a compulsory title decoration.
- `h1(doc,text)`, h2 and h3 use real styles. `para(doc,text,size=None,color=None,align="l",keep_next=False)` accepts **bold**, _italic_ and `code` notation, as do kit list/table text functions. Literal external strings that use those delimiters may need direct python-docx runs to preserve them exactly.
- `bullets(doc,items)` accepts strings or (text, [children]) pairs. `numbered(doc,items)` starts a fresh real numbered list for each call.
- `table(doc,headers,rows,widths=None,align=None,total_row=False,zebra=False,size=9.5,caption=None,header_fill=None)` uses relative column widths and repeating headers. Set numeric alignment explicitly when values contain units or special formats. Do not put long prose in a table simply to create a box.
- `figure(doc,path,width=None,caption=None)` uses an inline image. Declare the image input, preserve aspect ratio, check height and supply meaningful alternative text where needed. `chart(doc,kind,categories,series,...)` is available when a chart helps explain actual data.
- `page_break`, `landscape_section` and `portrait_section` are available for deliberate major boundaries or wide tables. Prefer flowing content over manual breaks after every section.
- `contents(doc,entries)` is a **static** list; use only page numbers verified against the final render. For an automatic TOC use a genuine field and verify its update.
- `money`, `pct` and `num` format computed values; pct takes a fraction. Use the correct currency instead of assuming dollars.
- `kpis` and `callout` are optional components, not report requirements. They use layout tables; prefer native paragraphs for accessible reading order and ordinary prose.

Use Theme(accent="RRGGBB") from lori_design.theme only when a brand accent helps. Direct python-docx on the same document is appropriate for layouts the kit does not implement. Do not claim custom font availability or perfect Word/LibreOffice pagination parity. Validate and render every final page after application; see the verification reference.

## Colour roles for new documents

Choose `palette`: `editorial` (deep teal), `mineral` (slate blue), `terracotta` (warm earth), or `monochrome` (formal neutral). An optional six-digit `accent` overrides the brand fill. `document_theme` retains that fill and derives readable heading/link tones. Table text uses a contrasting foreground. Use one palette throughout the deliverable; use monochrome where the genre calls for it. Supplied templates remain authoritative. Inspect the actual PDF export and final rendered colours, including table headings, links and figures; a correct DOCX colour value does not prove the export.
