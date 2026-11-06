# Design principles for documents people will use

A good document is read quickly and trusted. The reader should know what it is, what matters and what to do within seconds. These rules apply to every format; the `lori_design` kit applies most of them for you, so your job is the content and the judgment.

## Start from the reader
- Name the audience and the decision the file supports before choosing a layout: a leadership summary, an analyst's model, a client proposal and an internal checklist look different.
- Lead with the answer. Put the conclusion, the key numbers and the recommendation first; detail follows for those who want it.
- Write headlines as findings, not labels: "AMER leads on sales while APAC sells the most units", not "Sales by region". A slide or section title should survive being read alone.
- Cut anything that does not help the reader act: filler intros, repeated summaries, decoration, tables that restate a chart.

## Hierarchy and restraint
- One accent colour (the kit's default is a deep navy; use the member's brand colour if they gave one) and neutral greys. Never a rainbow, gradient, drop shadow, clip art or stock emoji.
- One font family (Arial). Use size and weight for hierarchy: title, heading, body, caption. Three sizes is plenty on a page; more means the hierarchy is unclear.
- White space is structure. Generous margins, consistent spacing, aligned edges. Do not fix crowding by shrinking text: cut words or split the page.
- Align like with like: text left, numbers right, headers matching their column. Keep a column of numbers in one format with the same decimals and the unit in the header (`Sales (USD)`), not repeated in every cell.
- Emphasis is rare. Bold a number or a phrase that matters; do not bold whole sentences or underline.

## Content integrity
- Never invent facts, sources, customer names, quotes or numbers presented as real. When the member asks for sample or illustrative data, make it plausible and label it ("Illustrative data") where a reader will see it: a subtitle, a footnote or a note beside the table.
- Totals, shares and differences are calculated, not typed: formulas in workbooks, values computed in code for documents. Check that they reconcile (parts sum to the total; shares sum to 100%).
- Say what you assumed. If the request was ambiguous, pick the sensible reading, state it in one line in the document or your reply, and carry on.
- Use plain, specific language. Spell out an acronym once. Dates in an unambiguous form (12 Oct 2026 or 2026-10-12), currency with its symbol or code.
- Keep to the length asked for. "About four pages" means three and a half to four and a half. Control length with content and spacing, not by shrinking the font or inserting page breaks.

## Details that separate polished from default
- Real structure: heading styles for headings, list styles for lists, table headers marked as headers, slide titles in title placeholders. Structure is what makes a document navigable, accessible and editable.
- No placeholder text, no "Lorem ipsum", no "TODO", no empty sections, no template instructions left in.
- Charts earn their place: one message each, titled with the takeaway, bars start at zero, direct labels instead of a legend when possible, no 3-D, no more than six series. If a table says it better, use a table.
- Tables: a header row that stands apart, light row separators, no full grid, numbers right-aligned, totals visually distinct, columns sized to their content.
- Consistent naming and capitalisation, consistent punctuation in lists, consistent number formats everywhere.
- A file name a person would choose: `q3-operations-review.docx`, not `output_final_v2.docx`.

## Colours and type that read well
- Body text at least 10 pt in documents and PDFs, 14 pt in slides. Contrast ratio at least 4.5:1 for body text; never grey text under 9 pt.
- Do not rely on colour alone to carry meaning; pair it with a label or a sign.
- Arial renders identically on every machine and in the sandbox. Do not specify fonts the member may not have. Characters outside Latin scripts (for example Chinese, Japanese, Arabic) are not available in the sandbox fonts; say so instead of delivering boxes.
