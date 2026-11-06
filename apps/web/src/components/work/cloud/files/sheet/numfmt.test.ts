import { describe, expect, it } from "vitest";
import { formatValue, isDateFormat, resolveFormatCode } from "./numfmt";
import { ERRORS } from "./values";

const fmt = (value: number | string | boolean | null, code: string, date1904 = false) => formatValue(value, code, date1904).text;

describe("number formats", () => {
  it("shows General as a person would read it", () => {
    expect(fmt(1234.5, "General")).toBe("1234.5");
    expect(fmt(0.1 + 0.2, "General")).toBe("0.3");
    expect(fmt(1e21, "General")).toBe("1E+21");
    expect(fmt(-42, "General")).toBe("-42");
    expect(fmt("text", "General")).toBe("text");
    expect(fmt(true, "General")).toBe("TRUE");
    expect(fmt(null, "General")).toBe("");
    expect(formatValue(ERRORS["#DIV/0!"], "0.00").text).toBe("#DIV/0!");
  });
  it("formats fixed decimals, thousands and money", () => {
    expect(fmt(3.14159, "0.00")).toBe("3.14");
    expect(fmt(2, "0.00")).toBe("2.00");
    expect(fmt(1234567.891, "#,##0")).toBe("1,234,568");
    expect(fmt(1234567.891, "#,##0.00")).toBe("1,234,567.89");
    expect(fmt(999.5, "#,##0")).toBe("1,000");
    expect(fmt(1.005, "0.00")).toBe("1.01");
    expect(fmt(0.5, "0")).toBe("1");
    expect(fmt(154965, "$#,##0")).toBe("$154,965");
    expect(fmt(1234.5, '"$"#,##0.00')).toBe("$1,234.50");
    expect(fmt(5, "000")).toBe("005");
    expect(fmt(0, "#,##0")).toBe("0");
    expect(fmt(0, "#")).toBe("");
  });
  it("formats negatives by section, with parentheses and colour", () => {
    expect(fmt(-1234, "#,##0")).toBe("-1,234");
    expect(fmt(-1234, "#,##0;(#,##0)")).toBe("(1,234)");
    expect(formatValue(-1234, "#,##0;[Red](#,##0)").color).toBeTruthy();
    expect(fmt(-5, "$#,##0.00_);($#,##0.00)")).toBe("($5.00)");
    expect(fmt(5, "$#,##0.00_);($#,##0.00)")).toBe("$5.00 ");
    expect(fmt(0, '0;-0;"zero"')).toBe("zero");
    expect(fmt(-0.2, "0.0")).toBe("-0.2");
  });
  it("formats percentages", () => {
    expect(fmt(0.353, "0.0%")).toBe("35.3%");
    expect(fmt(0.5, "0%")).toBe("50%");
    expect(fmt(1.2345, "0.00%")).toBe("123.45%");
    expect(fmt(-0.05, "0.0%")).toBe("-5.0%");
  });
  it("formats scientific, scaling and optional decimals", () => {
    expect(fmt(12345.678, "0.00E+00")).toBe("1.23E+04");
    expect(fmt(0.00012, "0.0E+0")).toBe("1.2E-4");
    expect(fmt(1500000, '0.0,,"M"')).toBe("1.5M");
    expect(fmt(2500, "0.0,")).toBe("2.5");
    expect(fmt(5, "0.##")).toBe("5.");
    expect(fmt(5.25, "0.##")).toBe("5.25");
    expect(fmt(5.2, "0.##")).toBe("5.2");
    expect(fmt(123456789, "000-00-0000")).toBe("123-45-6789");
  });
  it("formats dates and times from serial numbers", () => {
    // 46217 = 2026-07-14
    expect(fmt(46217, "yyyy-mm-dd")).toBe("2026-07-14");
    expect(fmt(46217, "m/d/yyyy")).toBe("7/14/2026");
    expect(fmt(46217, "mmm d, yyyy")).toBe("Jul 14, 2026");
    expect(fmt(46217, "dddd, mmmm d")).toBe("Tuesday, July 14");
    expect(fmt(46217, "mmm-yy")).toBe("Jul-26");
    expect(fmt(46217.75, "yyyy-mm-dd hh:mm")).toBe("2026-07-14 18:00");
    expect(fmt(0.5, "h:mm AM/PM")).toBe("12:00 PM");
    expect(fmt(0.25, "h:mm AM/PM")).toBe("6:00 AM");
    expect(fmt(0.999999, "h:mm:ss")).toBe("0:00:00");
    expect(fmt(1.5, "[h]:mm")).toBe("36:00");
    expect(fmt(0.0006944444, "mm:ss")).toBe("01:00");
    expect(fmt(61, "yyyy-mm-dd")).toBe("1900-03-01");
    expect(fmt(43101, "yyyy-mm-dd", false)).toBe("2018-01-01");
    expect(fmt(1462 + 43101 - 1462, "yyyy-mm-dd", true)).toBe("2022-01-02");
  });
  it("applies built-in ids and detects date formats", () => {
    expect(resolveFormatCode(14, new Map())).toBe("m/d/yyyy");
    expect(resolveFormatCode(164, new Map([[164, "0.0x"]]))).toBe("0.0x");
    expect(resolveFormatCode(999, new Map())).toBe("General");
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat("0.00")).toBe(false);
    expect(isDateFormat("General")).toBe(false);
    expect(isDateFormat('0.0 "m"')).toBe(false);
  });
  it("formats text cells with a text section and leaves others alone", () => {
    expect(fmt("abc", '@" units"')).toBe("abc units");
    expect(fmt("abc", "0.00")).toBe("abc");
  });
  it("applies conditions", () => {
    expect(fmt(5, '[<10]"small";[>=10]"big"')).toBe("small");
    expect(fmt(50, '[<10]"small";[>=10]"big"')).toBe("big");
  });
});
