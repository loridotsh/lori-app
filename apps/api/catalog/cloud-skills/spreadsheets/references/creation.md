# Workbook creation with the lori_design kit

`lori_design.xlsx_kit` is installed in the sandbox (built on XlsxWriter). It gives every workbook a calm, professional look: Arial 10, a dark header row, hairline row separators, right-aligned typed numbers, negative values in red, frozen headers, filters, no gridlines, tidy column widths, landscape printing fitted to one page wide, and a footer with sheet name and page number.

## A complete workbook

```python
import datetime as dt
from lori_design.xlsx_kit import Book

book = Book("q3-sales.xlsx", title="Q3 sales", author="Operations")

# Data sheets first, so later sheets can point at their totals.
tables = {}
for region, rows in {"EMEA": emea_rows, "APAC": apac_rows, "AMER": amer_rows}.items():
    sheet = book.sheet(region)
    sheet.title(f"{region} sales", "Illustrative transactions, USD")
    tables[region] = sheet.table(
        ["Customer", "Product", "Date", "Units", "Unit price", "Total"],
        rows,                                           # [name, product, dt.date(...), 12, 480.0, None]
        formats=["text", "text", "date", "int", "money", "money"],
        formulas={5: "={Units}*{Unit price}"},          # a formula per row, by column NAME
        total_row=["Total", "", "", "sum", "", "sum"],
    )

summary = book.sheet("Summary", first=True, tab_color="1E3A5F")     # first=True: the first tab, and the one the workbook opens on
summary.title("Q3 sales summary", "Illustrative data. Totals are live formulas that point at each regional sheet.")
summary.kpis([
    ("Combined sales", "=" + "+".join(f"{r}!{t.total_cell(5)}" for r, t in tables.items()), "money"),
    ("Units",          "=" + "+".join(f"{r}!{t.total_cell(3)}" for r, t in tables.items()), "int"),
])
rows = [[r, book.ref(r, t.total_cell(3)), book.ref(r, t.total_cell(5))] for r, t in tables.items()]
by_region = summary.table(["Region", "Units", "Sales"], rows, formats=["text", "int", "money"], total_row=["Total", "sum", "sum"])
summary.chart("column", by_region, categories=0, values=[2], title="Sales by region", number_format="$#,##0", anchor="G6")
book.close()
```

## The API

**`Book(path, theme=DEFAULT, title=None, author=None)`**
- `book.sheet(name, tab_color=None, landscape=True, gridlines=False, first=False)` returns a `Sheet`. `first=True` puts that sheet at the front of the tab order even though you built it last. Names are at most 31 characters and cannot contain `[ ] : * ? / \`.
- `book.ref("EMEA", "F23")` gives `=EMEA!F23` for another sheet's cell (use `table.total_cell(col)` to find a total).
- `book.close()` writes the file.

**`Sheet`**
- `title(text, subtitle=None)`, `heading(text)`, `note(text)`, `skip(n)`: text blocks. Content starts in column B with column A as a narrow margin.
- `table(headers, rows, formats, widths, formulas, total_row, freeze, filter, wrap, input_cols)` writes a data table and returns a `TableRef`.
  - `formats`: one per column: `text`, `int`, `num1`, `num2`, `money`, `money2`, `pct` (value is a fraction: 0.123 shows 12.3%), `pct0`, `date`, `month`, `multiple`, or a raw Excel format string.
  - `formulas={column_index: "={Units}*{Unit price}"}`: `{Header name}` becomes that column's cell on the same row, so you never write column letters. The kit calculates the result and stores it.
  - `total_row=True` sums every numeric column, or give one entry per column: a label, `"sum"`, `"avg"`, `"min"`, `"max"`, `"count"`, or `""`.
  - `freeze` keeps the header visible while scrolling: by default only for tables of 12 or more rows, once per sheet. A short summary table is left unfrozen.
  - `wrap=[i]` wraps long text columns; `input_cols=[i]` marks columns the member is meant to edit (blue text, light fill).
- `inputs([(label, value, format)], note=None)` writes an assumptions block and returns `{label: absolute reference}` so formulas can point at them (for example `refs["Tax rate"]`).
- `kpis([(label, value_or_formula, format)], span=2)`: a strip of headline numbers.
- `put("B3", value_or_formula, kind, bold)`: write one cell by address for layouts that are not a table.
- `chart(kind, table, categories, values, anchor, title, size, number_format, stacked)`: native Excel charts (`column`, `bar`, `line`, `pie`, `area`) from a table's columns.
- `dropdown("D2:D40", ["Open", "Closed"])`, `flag("D2:D40", ">", 0.2)`, `data_bars(range)`, `color_scale(range)`: validation and conditional formatting.
- `TableRef`: `.range(col)`, `.header(col)`, `.total_cell(col)`, `.first_row`, `.last_row`.

## Formulas that stay correct
- Reference input cells, not constants: `=Revenue*(1-'Tax rate')` through `inputs()`; put `0.21` in one labelled cell.
- Use `book.ref(...)` for cross-sheet links and write source sheets before dependent sheets so their values are known.
- Percentages are stored as fractions with a `pct` format. Money is stored as a number with a `money` format. Dates are `datetime.date` values.
- Supported by the kit's own calculator (so the stored value is exact): arithmetic, references (also across sheets and ranges), `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `ROUND`, `IF`. For other functions (`SUMIFS`, `VLOOKUP`, `INDEX/MATCH`, text functions) compute the value in Python and pass it with the formula: `sheet.put("D5", "=SUMIFS(C:C,A:A,\"EMEA\")", "money", result=12345.0)`. Then check it matches your independent calculation.

## Structure that reads well
- **Summary first**, with the answer in the first screen: a title, two to four KPIs, a small table or a chart. Not a wall of cells.
- **One table per concern** with a header row, consistent column order, units in the header (`Sales (USD)`), and a total row where totals make sense.
- **Inputs** gathered in one labelled block with a note that blue cells are editable.
- **Notes** in ordinary cells beside or under the table, short and italic. No cell comments for essential information.
- A `README` sheet only for complex models: purpose, how to use, assumptions, colour key.
- Charts: one message each, titled with the takeaway, bars from zero, placed beside the table they summarise.

## Using pandas or openpyxl instead
The kit is the default for new workbooks. If you analyse data with pandas or write with openpyxl, still apply the same rules (typed values, number formats, frozen header, no gridlines on presentation sheets, formulas for derived values) and still look at the result with `render_document`.
