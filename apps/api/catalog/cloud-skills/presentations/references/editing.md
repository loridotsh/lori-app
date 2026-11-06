# Editing an existing deck

Preserve the member's template: slide masters, layouts, fonts, colours, images and repeated elements. Follow them over any default.

## Steps
1. `inspect_document` the file (slide count, layouts, shapes) and `render_document` it so you know what the deck looks like. List the file in `inputPaths` in every command that reads it.
2. Open it with python-pptx and change only what was asked. Save under a **new name** (for example `deck-v2.pptx`) unless the member asked to replace the original.
3. Validate and render the slides you changed, and a few you did not, to confirm nothing else moved.

## Safe patterns
```python
from pptx import Presentation

prs = Presentation("deck.pptx")
slide = prs.slides[2]
for shape in slide.shapes:
    if shape.has_text_frame:
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:                     # edit inside runs to keep formatting
                run.text = run.text.replace("Q2", "Q3")
prs.save("deck-v2.pptx")
```
- Edit text inside runs, not by assigning `text_frame.text`, which discards formatting.
- Add a slide with one of the deck's own layouts (`prs.slide_layouts[n]`) and fill its placeholders; do not build a new look.
- Chart data: `chart.replace_data(CategoryChartData(...))` keeps the chart's formatting.
- Reordering, duplicating or deleting slides: change `prs.slides._sldIdLst` carefully, and remove relationships when deleting.
- Exact text replacement across the deck (including notes) can use the document helper: write a JSON request and run `python3 "$LORI_DOCUMENT_HELPER" request.json` with `{"action": "replace_text", "path": "deck.pptx", "outputPath": "deck-v2.pptx", "oldText": "...", "newText": "...", "part": "ppt/slides/slide3.xml"}`; it needs one exact match and leaves the original unchanged.

## Applying a template to new content
Open the template as the base (`Presentation("template.pptx")`), delete its sample slides if asked, and add slides from its layouts. Check each layout's placeholder names and positions first; render the result and compare it with the template.

## Do not
- Do not rebuild a deck from extracted text.
- Do not change fonts, colours, masters or layouts you were not asked to change.
- Do not overwrite the original; make a copy and say so.
- Do not leave empty placeholders ("Click to add text") on any slide.
