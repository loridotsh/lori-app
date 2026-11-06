import localFont from "next/font/local";

// next/font requires literal options, so the Latin and Latin Extended
// unicode-range strings are repeated rather than shared.
//
// Each subset is its own family so the browser only fetches Latin Extended
// when a page contains those characters. The metric-matched fallback sits on
// the last family, otherwise it would capture Latin Extended glyphs first.
const interLatin = localFont({
  src: "./fonts/inter-latin.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter-latin",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const interLatinExt = localFont({
  src: "./fonts/inter-latin-ext.woff2",
  weight: "100 900",
  display: "swap",
  preload: false,
  variable: "--font-inter-latin-ext",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

const monoLatin = localFont({
  src: "./fonts/jetbrains-mono-latin.woff2",
  weight: "100 800",
  display: "swap",
  preload: false,
  variable: "--font-mono-latin",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const monoLatinExt = localFont({
  src: "./fonts/jetbrains-mono-latin-ext.woff2",
  weight: "100 800",
  display: "swap",
  preload: false,
  variable: "--font-mono-latin-ext",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

export const fontVariables = [interLatin, interLatinExt, monoLatin, monoLatinExt]
  .map((font) => font.variable)
  .join(" ");
