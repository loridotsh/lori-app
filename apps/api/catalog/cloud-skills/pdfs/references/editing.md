# Existing PDFs and forms

Declare every source in inputPaths; commands start in a fresh sandbox. Inspect page count, dimensions, rotation, annotations, text/scans, form fields and signatures before editing. Save a new revision. Ordinary page operations should preserve text/vectors/links; rebuild only when requested or necessary, with material fidelity changes explained.

## Page operations

```python
from pypdf import PdfReader, PdfWriter


def select_pages(source, destination, pages):
    reader = PdfReader(source)
    if not pages or any(p < 1 or p > len(reader.pages) for p in pages):
        raise ValueError("Page selection is one-based and must be within the document")
    writer = PdfWriter()
    for number in pages:
        writer.add_page(reader.pages[number - 1])
    with open(destination, "wb") as handle:
        writer.write(handle)
    assert len(PdfReader(destination).pages) == len(pages)
```

For a complete merge use writer.append for every source, then check total page count and order. For rotation/cropping inspect page boxes and coordinates first; pixels and PDF points differ in scale and origin. For stamps create a same-size ReportLab overlay and merge_page; overlays do not remove underlying content. Check retained links/bookmarks/annotations and metadata relevant to the task.

## Fill interactive forms on every page

Inspect canonical fields and Widget annotations, including Parent/Kids relationships, before filling. Use actual field names and checkbox/radio export values. Do not blindly repair an ambiguous duplicate field tree. XFA and signature-preserving changes are unsupported; rewriting a signed file may invalidate the signature.

For an ordinary, inspected AcroForm:

```python
from pypdf import PdfReader, PdfWriter


def fill_form(source, destination, values):
    reader = PdfReader(source)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    fields = writer.get_fields() or {}
    missing = set(values) - set(fields)
    if missing:
        raise ValueError("Unknown form fields: " + repr(sorted(missing)))
    # None means all pages. Keep appearances and stored values in sync.
    writer.update_page_form_field_values(None, values, auto_regenerate=False)
    with open(destination, "wb") as handle:
        writer.write(handle)
    final = PdfReader(destination).get_fields() or {}
    for name, expected in values.items():
        assert str(final[name].get("/V", "")) == str(expected), name
```

Render all pages and confirm values are visible, including fields beyond page one. Preserve interactivity by default. Flatten only when a static result is requested; painting appearances alone does not remove widgets. Reopen the result and verify both the canonical field tree and widget state relevant to the requested output. A visible value is not proof of a correct stored field.

## Scans and redaction

read_document can use bundled English OCR for pages without text. Follow page/text pagination and retain provenance; qualify uncertain transcription and unsupported languages rather than guessing. Use rendered pages when exact visual context matters.

Redaction must remove content. Render pages to images, paint the correct regions, then build a fresh image-only PDF without copying source objects/attachments; or regenerate from a source with the sensitive content removed. Re-extract text and inspect objects/attachments as well as every affected rendered region. A black rectangle drawn over source text is not redaction. Explain that a rasterized copy loses searchable text/vectors/forms. Do not rasterize normal page edits.

Validate the saved output and inspect every final page. Do not claim PDF/UA, PDF/A, signature validity or lossless reconstruction without the corresponding checks.
