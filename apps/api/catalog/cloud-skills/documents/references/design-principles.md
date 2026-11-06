# Design for the reader

Use the supplied template, brand, audience and requested length as the design authority. For a new document without a reference, choose a restrained, coherent direction and complete ordinary work without a design interview.

## Choose a useful form

| Deliverable | Composition |
| --- | --- |
| Letter or memo | Known recipient/date, purpose, supporting paragraphs, next action and a complete signing block. Usually no cover or running footer. |
| Decision brief | Decision, evidence, options/tradeoffs and next action. Use a comparison table only when it helps the decision. |
| Report or proposal | Specific title, useful opening summary, evidence/scope, findings/deliverables and actions/terms. A cover is optional. |
| Procedure | Purpose, prerequisites, native numbered steps, exceptions and verification. Keep warnings beside the relevant step. |
| Invoice or form | Required fields, dates, units and computed totals, with space for responses. Editable inputs need real controls or an editable source. |

These are starting points, not compulsory headings. Do not turn every task into an executive report, add invented metrics or fill pages with repeated summaries.

## Choose one palette

Pass the creation recipe a `palette` before building. Use the same roles throughout the Word source, standalone PDF and matching PDF export.

| Palette | Accent fill | Useful starting point |
| --- | --- | --- |
| editorial | #0E5B60 | Advisory briefs, research and decision documents |
| mineral | #234E70 | Operational reports and corporate proposals |
| terracotta | #874A35 | Editorial proposals and warmer client-facing documents |
| monochrome | #29313D | Formal or explicitly neutral documents |

Use a supplied brand through the optional six-digit `accent`. Retain the template's design for ordinary edits. A plain formal letter can remain monochrome. The palette names are not industry rules.

Use dark ink for long reading, an accent for section headings and compact table headers, muted text for secondary metadata, a very light tint for alternate rows, and white for the page. Let the title be primarily typographic. A coloured title bar, gradient, badge, KPI row, giant metric, cover or repeated card is not a default requirement.

The recipes retain the brand fill while deriving readable heading/link tones and contrasting header text. Target at least 4.5:1 for normal text/background pairs, including captions and cells. Large text can meet 3:1; the recipes use the stricter text threshold for accents. Retain status labels, chart labels and units so colour is never the only signal. Contrast checks alone do not establish full accessibility.

## Typography and layout

- Use a coherent family and scale. Ordinary body text usually needs 11–12 pt, comfortable leading around 1.15–1.4, headings around 13–18 pt and a report title around 22–28 pt. Preserve requested typography. Do not shrink the body to force a page count.
- Set page size explicitly. Preserve an existing size; otherwise choose A4 or Letter. Start near 0.75–1 inch margins and adjust to the genre. Use paragraph spacing, not blank paragraphs, repeated spaces or tabs to position prose.
- Keep headings with their opening paragraph, figures with captions and the signing block together. Let long body sections and tables flow. Avoid a mostly empty last page or a short isolated title fragment; adjust wording or line breaks only when meaning and the user's constraints permit.
- Use genuine Word heading/list styles. Make tables expose structured comparisons, not serve as boxes for prose. Wrap cells, repeat headers, align numbers and their headings, identify units, use restrained row tints and avoid fixed heights. Split wide tables or use landscape before making type unreadable.
- Use charts only for real comparisons, trends or relationships. Preserve aspect ratio, label units and sources, and cap figure height as well as width. Do not invent chart data or brand assets.

## Preserve content and write naturally

Use concrete claims, specific headings and connected prose in the intended author's voice. Remove stock introductions, slogans, repeated summaries, excessive bold fragments and generic recommendations. Retain names, dates, units, qualifications, comparisons, sources and uncertainty. Compute totals independently.

Preserve the user's language and symbols. Choose fonts covering the actual text and inspect the render; embedding does not establish glyph coverage or shaping. Do not silently strip or transliterate characters. Keep ordinary readable citations, never internal tool tokens. Do not invent identities, quotations, addresses, signatures or commitments. Label illustrative data where its reader sees it.

## Check actual colour and export

Set explicit RGB values for newly authored Word styles/runs and remove conflicting theme colour/tint/shade attributes when applying explicit colours. Avoid automatic colours for essential text. This is not permission to restyle a supplied template.

In ReportLab, a table's TEXTCOLOR setting does not restyle an already-created Paragraph: set its ParagraphStyle foreground too. Save/restore canvas state around repeated page furniture.

For a DOCX/PDF pair, author one source and inspect the actual final PDF export separately. Check accent headings, table fill/text pairs, links, captions, charts, symbols and page backgrounds. Review every page at readable size for clipping, lost colour, low contrast, missing glyphs and an orphaned closing. A correct token in XML does not prove the render. Derive TOC/page numbers from final layout, never guesses.

After a correction, read back and render the changed final revision. If image review is incomplete, describe the result as a draft with layout unverified. PDF/UA, PDF/A, signature preservation and complete accessibility need separate format-specific validation.

## Primary references

Reviewed 21 October 2026:
- [python-docx styles](https://python-docx.readthedocs.io/en/latest/user/styles-using.html) and [font colour precedence](https://python-docx.readthedocs.io/en/latest/dev/analysis/features/text/font-color.html).
- [ReportLab paragraphs](https://docs.reportlab.com/reportlab/userguide/ch6_paragraphs/) and [tables](https://docs.reportlab.com/reportlab/userguide/ch7_tables/).
- [W3C contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [use of colour](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).
- [LibreOffice PDF export](https://help.libreoffice.org/latest/en-US/text/shared/01/ref_pdf_export_general.html).
