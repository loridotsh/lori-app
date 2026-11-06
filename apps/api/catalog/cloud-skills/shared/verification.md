# Verify before you say it is done

Writing a file is not finishing the job. A document is done when you have looked at it and it is right. Plan the verification as part of the task, and budget steps for it: build in one command, apply, then check.

## The loop
1. **Build** the deliverable completely in one `run_command` (all independent files together). The member approves the command and then applies the generated files.
2. **For a workbook, run the design check** (`python -m lori_design.lint file.xlsx` in `run_command`, file in `inputPaths`) and fix everything it reports; it finds problems a structural check cannot, such as text that is white on white. Then **check the structure** with `validate_document` on the saved file (and `expectedText` for a few key phrases). This proves the file opens and the content is present. It does not prove the layout is good.
3. **Look at it.** Call `render_document` on the saved file. The rendered pages appear directly in the result: no approval, nothing saved. Render up to 6 pages per call. For a long document look at the first pages, a middle page with a table or chart, and the last page; render more if anything looks off.
4. **Fix what you see**, rebuild in one command, apply, and look again. Two passes is normal. Do not deliver with a known defect.
5. **Report honestly.** Say what each file contains, the page or slide count, any assumption, and anything you could not verify. Never claim a visual review you did not do.

## What to look for on every rendered page
- Text clipped, overlapping, running off the edge, or wrapping in a cramped way.
- A heading stranded at the bottom of a page, a table row split awkwardly, a figure separated from its caption, a nearly empty last page.
- Misaligned columns, numbers not right-aligned, inconsistent decimals or currency symbols.
- Unreadable charts: overlapping labels, truncated axes, a legend hiding data, series that look alike.
- Empty cells that should hold values (a zero or dash where a total belongs means a formula was stored without its result).
- Placeholder text, wrong names, wrong dates, numbers that do not match the source.
- Length: matches what was asked for.

## Format-specific checks
- **Word:** headings use heading styles; every page has the footer and page number; the table header repeats if a table spans pages; lists are real lists; no blank paragraphs used for spacing.
- **Excel:** open on the summary sheet; header rows frozen; filters on tables; no gridlines on presentation sheets; every formula cell shows a value; totals reconcile with an independent calculation in Python; no `#REF!`, `#DIV/0!` or `###`; columns wide enough; dates and currency are real values with number formats, not text.
- **PowerPoint:** one idea per slide; no slide with more than about 40 words of body text; every title is a finding; nothing outside the slide edge; chart labels readable at a distance; speaker notes where the member will present.
- **PDF:** fonts embedded, links work, page numbers present, tables break cleanly, nothing is cut at the margins.

## Reading a file back
- `read_document` extracts text from DOCX, XLSX, PPTX and PDF; `inspect_document` shows structure, sheets and table shapes. Use them to check numbers against your source data, not only the pictures.
- Recompute totals independently in Python from the source data and compare them with what the file shows.

## When something fails
- Read the error. If a command failed because a file was not found, the sandbox starts empty each time: list every existing file the command reads in `inputPaths` (files named in the command are added automatically, but not paths built at run time).
- A file a command creates exists only after the member applies it. To work on it in a later command, list it in `inputPaths`.
- Do not retry the identical command. Change what failed.
