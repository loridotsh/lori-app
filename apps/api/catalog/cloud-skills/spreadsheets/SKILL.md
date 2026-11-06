---
name: spreadsheets
description: Build and revise workbooks that are clear, correct and live: typed values, working formulas, frozen headers, summaries and native charts.
---

# Spreadsheets (Excel)

Use for XLSX creation, data analysis and workbook revision (CSV/TSV can be read as text). In Cloud Work there are no "jobs" and no publish step: you build files with `run_command` in a private offline sandbox, the member approves the command and then the generated files, and `render_document` lets you look at the result.

**Before authoring, load `references/creation.md` (the build recipe) and skim `references/design-principles.md`.** Load `references/verification.md` before you start checking.

## How to work
1. Understand the question the workbook answers and who will use it. Inspect any source data first (`inspect_document`, `read_document`): sheet names, units, types, missing values.
2. Plan the sheets: usually a **Summary** first (the answer, key figures, one chart), then the data or working sheets. Keep the simplest workbook that does the job. Do not duplicate the same table across sheets.
3. Build with the `lori_design` kit in **one** `run_command` (`from lori_design.xlsx_kit import Book`). It writes typed numbers and dates, number formats, header styling, frozen headers, filters, hidden gridlines, native charts, print setup, and **stores the real result next to every formula it writes**.
4. After the member applies the file, run the design check: `run_command` with `python -m lori_design.lint <file>` (list the file in `inputPaths`). It reads any workbook, including ones made with openpyxl, and reports text that cannot be seen (white on white), coloured rows with nothing in them, formulas with no stored result, numbers too wide for their column and code-style titles. Fix every line it prints and run it again until it says "No problems found". Then `validate_document`, then `render_document` and look at every sheet you made. Check the numbers against an independent calculation in Python.
5. Reply with what each sheet holds, key results, assumptions and any limits.

## Rules that matter
- Each command starts in an empty sandbox. List every existing file it reads in `inputPaths`; a file a command creates exists only after the member applies it.
- Only the working directory and `$TMPDIR` are writable. `/tmp` and other absolute paths are read-only: use relative paths for output and `$TMPDIR` for scratch files.
- Derived values are formulas (totals, shares, differences), so the workbook stays live. Inputs the member may change sit in clearly marked input cells that formulas point at; never bury a constant inside a formula.
- Store values as numbers and dates with number formats. Never write `"$1,200"` or `"2026-07-14"` as text.
- **Cached values.** Readers that do not recalculate (the preview, LibreOffice rendering, pandas) show whatever is stored beside a formula. The kit evaluates what it writes. For a formula the kit cannot calculate (`SUMIFS`, `VLOOKUP`, ...), compute the value in Python and pass it: `sheet.put(cell, formula, kind, result=value)`. An uncomputed formula shows 0 until recalculated. A workbook the kit built already carries its calculated results: do not run `recalculate_spreadsheet` on it (that creates a second, duplicate file). To change a kit workbook (reorder sheets, fix a label), **rebuild it with the kit** under the same name: opening it with openpyxl and saving throws every stored result away. The kit already puts a `first=True` sheet at the front of the tab order. Use `recalculate_spreadsheet` only on workbooks you must edit with openpyxl or the document helper, and if you do, move the superseded original to Trash with `manage_files` so the member is left with one file.
- If you write a workbook with openpyxl instead of the kit, every cell must carry its own look: give a white header text an explicit dark fill on that same cell (never rely on an Excel table style to supply it, and never colour a row you did not write), use readable titles ("Unit price", not `unit_price`), and set column widths wide enough for the numbers.
- Do not use merged cells in data areas, volatile functions, external links or macros. Keep sheet names short and clear.
- Do not search for or invent a "document job", `begin_document_job`, `publish_document` or `jobId`: they do not exist here.
- A supplied template or the member's instructions beat these defaults. Edit existing workbooks carefully; see `references/editing.md`.
- Never invent data presented as real. Label illustrative data on the sheet where a reader will see it.

## References
- `references/creation.md` - the kit and a full workbook recipe.
- `references/editing.md` - changing an existing workbook and recalculating.
- `references/design-principles.md` - what good looks like.
- `references/verification.md` - the build, validate, render, fix loop and a defect checklist.

Load a reference with `load_skill` using the exact name listed. Omit `reference` to load this guide.
