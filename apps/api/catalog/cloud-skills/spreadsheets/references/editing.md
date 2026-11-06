# Editing an existing workbook

Preserve what the member built: sheets, formulas, number formats, validations, named ranges, conditional formats, charts and images.

Members can open a workbook in the Files pane and edit cells and formulas themselves; each of their saves is a new version of the file. Read the current version (`inspect_document`) before you change it, never work from an earlier reading, and say if you write a new file rather than a changed copy of theirs.

## Steps
1. `inspect_document` the file (sheet names, ranges, formulas) and `render_document` it so you know what "unchanged" looks like. List the file in `inputPaths` in every command that reads it.
2. Choose the lightest safe edit:
   - **Values or formulas in existing cells:** the document helper preserves everything else. Write a small JSON request and run `python3 "$LORI_DOCUMENT_HELPER" request.json`:
     ```json
     {"action": "edit_cells", "path": "budget.xlsx", "outputPath": "budget-v2.xlsx",
      "part": "xl/worksheets/sheet1.xml",
      "cells": {"B4": 1200, "C4": "=B4*0.2", "D4": null}}
     ```
     Find the sheet part from `inspect_document`. Rows must already exist. Formulas are strings that start with `=`.
   - **Adding sheets, tables or formatting:** openpyxl (`load_workbook`) is fine for workbooks **without charts, images, pivot tables or macros**. openpyxl drops charts and pivots when it saves, so for those workbooks use the helper or tell the member what cannot be changed safely.
3. Save under a **new name** unless the member asked to replace the original, and say so.
4. Recalculate if you changed formulas (below), then validate and render, and compare against the original.

## Recalculating
Formulas written by a library carry no calculated result until a spreadsheet application recalculates them. Use `recalculate_spreadsheet` with `path` set to your edited file and a **different** `outputPath` (for example `budget-v2-calculated.xlsx`). It recalculates in the Office runtime and keeps the original formatting. Then read the values back (`read_document` or openpyxl with `data_only=True`) and check totals and error cells (`#REF!`, `#DIV/0!`, `#NAME?`).

If recalculation would leave two near-identical files, say which one is the final workbook.

## Do not
- Do not rebuild a workbook from extracted values: formulas, formats and links would be lost.
- Do not change units, signs, date systems or number formats you were not asked to change.
- Do not paste computed values over formulas.
- Do not overwrite the original; make a copy and say so.
- Do not leave `#REF!` or `#DIV/0!` in a delivered file.
