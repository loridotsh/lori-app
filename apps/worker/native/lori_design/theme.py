"""Design tokens shared by every document kit.

One restrained palette, one font family and a small type scale, so a workbook,
a deck, a report and a PDF made in the same session look like one product.
Colours are 6-digit hex strings without '#'. Arial is deliberate: it is on every
member's machine, and the sandbox renders it with metric-compatible Liberation
Sans, so what the agent checks is what the member sees.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import re

INK = "111827"        # titles, totals
TEXT = "1F2937"       # body
MUTED = "6B7280"      # captions, units, metadata
RULE = "D1D5DB"       # structural lines
HAIR = "E5E7EB"       # row separators
SURFACE = "F3F4F6"    # quiet panels
WHITE = "FFFFFF"
POSITIVE = "15803D"
NEGATIVE = "B91C1C"
WARNING = "B45309"

FONT = "Arial"
SERIF = "Times New Roman"

# Chart series, ordered so the first two are always clearly distinct.
SERIES = ["1E3A5F", "C2410C", "0F766E", "64748B", "B45309", "6D28D9", "BE185D", "4D7C0F"]


def _clean(color: str) -> str:
    color = color.lstrip("#").upper()
    if len(color) != 6 or any(c not in "0123456789ABCDEF" for c in color):
        raise ValueError(f"Colour must be a 6-digit hex value, got {color!r}")
    return color


def rgb(color: str) -> tuple[int, int, int]:
    color = _clean(color)
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def tint(color: str, amount: float) -> str:
    """Blend toward white: 0 is the colour, 1 is white."""
    r, g, b = rgb(color)
    mix = lambda v: round(v + (255 - v) * amount)
    return f"{mix(r):02X}{mix(g):02X}{mix(b):02X}"


def shade(color: str, amount: float) -> str:
    """Blend toward black: 0 is the colour, 1 is black."""
    r, g, b = rgb(color)
    mix = lambda v: round(v * (1 - amount))
    return f"{mix(r):02X}{mix(g):02X}{mix(b):02X}"


def luminance(color: str) -> float:
    def channel(v: int) -> float:
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in rgb(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def on_color(background: str) -> str:
    """Prefer white or ink; use black when neither reaches normal-text contrast."""
    foreground = WHITE if contrast(background, WHITE) >= contrast(background, INK) else INK
    return foreground if contrast(background, foreground) >= 4.5 else "000000"


@dataclass(frozen=True)
class Theme:
    """The accent is the only free choice; pass a brand colour to restyle everything."""

    accent: str = "1E3A5F"
    font: str = FONT
    series: list[str] = field(default_factory=lambda: list(SERIES))
    heading: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "accent", _clean(self.accent))
        if self.heading is not None:
            object.__setattr__(self, "heading", _clean(self.heading))
        # The accent leads every chart so a brand colour shows up where it counts.
        rest = [c for c in SERIES if c != self.accent]
        object.__setattr__(self, "series", [self.accent, *rest][: len(SERIES)])

    @property
    def accent_soft(self) -> str:
        return tint(self.accent, 0.92)

    @property
    def accent_mid(self) -> str:
        return tint(self.accent, 0.7)

    @property
    def on_accent(self) -> str:
        return on_color(self.accent)

    @property
    def readable_accent(self) -> str:
        """Keep the brand fill, but use a contrasting tone for text on white."""
        color = self.accent
        while contrast(color, WHITE) < 4.5:
            color = shade(color, .15)
        return color

    @property
    def heading_ink(self) -> str:
        return self.heading or INK


DEFAULT = Theme()

# Opt-in document palettes leave existing workbook and presentation defaults intact.
DOCUMENT_PALETTES = {"editorial": "0E5B60", "mineral": "234E70",
                     "terracotta": "874A35", "monochrome": "29313D"}


def document_theme(palette: str = "editorial", accent: str | None = None) -> Theme:
    """Coherent colour roles for a new Word/PDF document, not template restyling."""
    if not isinstance(palette, str) or palette not in DOCUMENT_PALETTES:
        raise ValueError("Unknown document palette")
    if accent is None:
        accent = DOCUMENT_PALETTES[palette]
    if not isinstance(accent, str) or not re.fullmatch(r"#?[0-9a-fA-F]{6}", accent):
        raise ValueError("accent must be a six-digit RGB hex colour")
    base = Theme(accent=accent)
    return Theme(accent=base.accent, heading=base.readable_accent)
