# Deck creation with the lori_design kit

`lori_design.pptx_kit` is installed in the sandbox (built on python-pptx). Slides are 16:9, use a real title placeholder (so outline view, navigation and screen readers work), native charts and tables, a quiet footer and slide number, and text measured to fit its box.

## A complete deck

```python
from lori_design.pptx_kit import Deck
from lori_design.theme import Theme    # optional: Theme(accent="B91C1C") for a brand colour

deck = Deck("Q3 operations review")                     # the title also appears in the footer
deck.title_slide("Q3 operations review", "Regional performance and priorities for Q4",
                 "Operations  |  October 2026", notes="Open with the headline.")
deck.kpis("Sales reached $501,560 across three regions",
          [("Combined sales", "$501,560", "USD, three regions"),
           ("Units", "3,145", "Across 60 records"),
           ("Transactions", "60", "20 per region")],
          caption="Constructed dataset; illustrative only.")
deck.chart("AMER leads on sales while APAC sells the most units", "column",
           ["EMEA", "APAC", "AMER"], {"Sales (USD)": [154965, 169530, 177065]},
           takeaway="AMER delivered 35.3% of combined sales.",
           number_format="$#,##0", caption="Source: constructed dataset")
deck.table("Regional results at a glance", ["Region", "Sales (USD)", "Units", "Share"],
           [["EMEA", "$154,965", "947", "30.9%"], ["APAC", "$169,530", "1,103", "33.8%"],
            ["AMER", "$177,065", "1,095", "35.3%"], ["Total", "$501,560", "3,145", "100.0%"]],
           widths=[2, 2, 1.4, 1.2], total_row=True)
deck.bullets("Three actions will sharpen the Q4 review",
             ["Validate source data with regional finance owners",
              ("Add a prior-period comparison", ["Use the same product definitions"]),
              "Agree on a single definition of units"], notes="Ask for owners and dates.")
deck.closing("Questions and next steps", ["Owner: Operations", "Next review: January 2027"])
deck.save("q3-operations-review.pptx")
print(deck.warnings)                                     # must be empty
```

## The slide types

| Method | Use it for |
| --- | --- |
| `title_slide(title, subtitle, meta, notes)` | The opening slide. |
| `section(title, note, notes)` | A divider between parts (solid accent). Only for longer decks. |
| `kpis(title, [(label, value, note)], caption, notes)` | Two to four headline numbers. |
| `chart(title, kind, categories, {series: values}, takeaway, number_format, caption, notes)` | A comparison or trend. kind: `column`, `bar`, `line`, `stacked`, `pie`. `takeaway` adds a short note beside the chart. Without `number_format`, labels keep the data's precision (3.1 stays 3.1); pass one for currency or percentages. |
| `table(title, headers, rows, widths, align, total_row, caption, notes)` | Exact values. About eight rows at most. |
| `bullets(title, items, notes, lead)` | Ideas and recommendations. Items can be `(text, [sub-points])`. |
| `two_column(title, left_heading, left_items, right_heading, right_items, notes)` | A contrast: before/after, option A/B. |
| `image(title, path, caption, notes)` | A photo or diagram, fitted without stretching. |
| `closing(title, lines, notes)` | The last slide: next steps, owners, contact. |

`deck.save(path)` writes the file. `deck.warnings` lists any text that did not fit.

## Craft notes
- **Story.** Read only the slide titles in order; they should tell the story. If a title is a topic ("Sales"), rewrite it as the finding.
- **Density.** Dense slides are for reading, sparse slides are for presenting; a deck should be mostly the second kind. Put detail in speaker notes (`notes=`) or an appendix.
- **Numbers.** Format them as text before passing them to `kpis` and `table` (`"$501,560"`, `"35.3%"`); pass raw numbers to `chart`.
- **Charts.** Bars start at zero; the kit does this. Do not chart more than six series. Use `bar` (horizontal) for long category names.
- **Images.** Use images that depict the subject; do not stretch or crop away evidence; do not reuse the same image repeatedly. If you need a generated chart image (rare), use matplotlib with the kit's palette and `image()`.
- **Length.** About one slide per minute spoken. A summary of results is three to five slides; a full review is eight to twelve.
- **Notes.** If the member will present, add `notes=` with the talking points, the source of each number and likely questions.

## Using python-pptx directly
You can reach the underlying presentation as `deck.prs` and add shapes yourself. Keep to Arial, the kit's margins and colours, and real title placeholders, and measure text with `lori_design.pptx_kit.fit_size(text, width_in, height_in, max_pt, min_pt)`, which returns `(size, fits)`, before placing it.
