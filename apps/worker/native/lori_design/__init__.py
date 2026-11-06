"""Lori's document design kit: premium defaults for Word, Excel, PowerPoint and PDF.

    from lori_design.docx_kit import *      # Word reports and letters
    from lori_design.xlsx_kit import *      # workbooks
    from lori_design.pptx_kit import *      # slide decks
    from lori_design.pdf_kit import *       # PDF reports

Every kit shares lori_design.theme: one restrained palette, one font family and a
small type scale. Pass Theme(accent="RRGGBB") to adopt a brand colour.
"""
from .theme import DEFAULT, Theme

__all__ = ["DEFAULT", "Theme"]
__version__ = "1.0.0"
