# Verify the exact final file

Budget verification as part of the task. A file that opens is not necessarily correct or readable. Checks on an earlier revision do not cover a later edit.

## Read, validate, render, repair

1. Build the requested deliverable completely with run_command where practical. Existing inputs must be declared in inputPaths. Check successful execution and application before claiming the file was saved.
2. Read back the saved file with read_document/inspect_document, following text/page pagination. Compare the whole requested scope with the inputs: names, dates, quantities, units, qualifications, sources and requested changes. Independently recompute totals. validate_document checks structure; expectedText checks key phrases, not full coverage.
3. Render every page of the final file with render_document in batches of up to 6 pages. Follow nextPage until complete and inspect each returned image at readable size. Render results contain images directly; there is no desktop job or publish step. Samples/contact sheets can guide iteration but do not prove the rest of a document is clean.
4. Repair defects, apply the new output and repeat the content/visual checks affected by the change; complete visual review must cover the final revision. If image review is unavailable or incomplete, describe the file as a draft with layout unverified. Never claim an image review from structural validation or a visualReview flag.

## Review every rendered page

Check clipping/overlap, missing glyphs, cramped cells, unexpected blank or nearly empty pages, orphaned headings, split captions, crowded footers, wrong paper/orientation, inconsistent typography, unreadable charts, placeholder text, leftover Markdown and requested length. Use typography/spacing appropriate to the document type; a letter need not have a footer, metrics or a cover. Preserve requested facts when correcting length.

## Native format checks

- Word: genuine heading/list styles, table header repetition, numbering restarts, intact sections/media/links and requested fields/comments/revisions. For a surgical edit compare untouched package parts. Comments may be absent in the PDF preview; inspect their range anchors, relationships and content types.
- PDF: final page count/order/boxes/rotation, searchable text, actual glyphs and embedded fonts. Check relevant hyperlinks/bookmarks, annotations and form values in both widgets and the canonical field tree. A font being embedded does not establish language shaping or PDF/UA/PDF/A. For redaction confirm target content is absent from source objects/attachments and extracted text as well as the rendered region.

Return only the requested saved deliverables and a concise description, with material limitations. Do not put workflow commentary inside the file or deliver scratch files unless asked. Do not call a draft fully reviewed. On a known failure, diagnose and change the cause; after an uncertain mutation, check the recorded/current outcome before retrying.

## Colour and export review

Inspect the actual final heading accents, table fills and cell text, captions, links, figures and page backgrounds. Check contrast on every used background and retain labels so colour is not the only signal. For Word/PDF pairs, inspect the PDF export separately: theme overrides, missing fonts or export settings can change the appearance. Check readable glyphs, source content, pagination and the complete signing block. Do not infer PDF/UA, archival compliance or complete accessibility from a visual pass or embedded fonts.
