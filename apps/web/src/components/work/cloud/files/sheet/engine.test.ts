import { describe, expect, it } from "vitest";
import { cellName, colIndex, colName, parseCell, parseRange } from "./address";
import { FormulaSyntaxError, parseFormula } from "./parser";
import { ERRORS, parseNumeric, toNumber } from "./values";
import { Calculator, cellKey, parseInput, restoreCell, setInput } from "./workbook";
import { at, book } from "./workbook-fixture";

const calc = (formula: string, cells: Record<string, string | number | boolean | null> = {}) =>
  at(book({ S: { ...cells, Z99: `=${formula}` } }), "Z99");

describe("addresses", () => {
  it("converts column letters both ways", () => {
    expect([0, 25, 26, 701, 702, 16383].map(colName)).toEqual(["A", "Z", "AA", "ZZ", "AAA", "XFD"]);
    expect(["A", "z", "AA", "XFD"].map(colIndex)).toEqual([0, 25, 26, 16383]);
    expect(colIndex("XFE")).toBe(-1);
    expect(colIndex("A1")).toBe(-1);
    expect(cellName(0, 0)).toBe("A1");
    expect(parseCell("$B$7")).toMatchObject({ row: 6, col: 1, absRow: true, absCol: true });
    expect(parseCell("A0")).toBeNull();
    expect(parseCell("1A")).toBeNull();
    expect(parseRange("C3:A1")).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
  });
});

describe("parser", () => {
  it("rejects what it cannot read instead of guessing", () => {
    for (const bad of ["", "1+", "(1", "SUM(1,", '"open', "Table1[Col]", "#BOGUS!", "1 2", "SUM(1 2)"]) expect(() => parseFormula(bad), bad).toThrow(FormulaSyntaxError);
  });
  it("bounds nesting and length", () => {
    expect(() => parseFormula("(".repeat(500) + "1" + ")".repeat(500))).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("1+".repeat(5000) + "1")).toThrow(FormulaSyntaxError);
  });
  it("reads references with sheets, ranges and absolute markers", () => {
    expect(parseFormula("=Sheet1!$A$1")).toMatchObject({ t: "ref", sheet: "Sheet1", r1: 0, c1: 0 });
    expect(parseFormula("='My Sheet'!B2:C3")).toMatchObject({ t: "ref", sheet: "My Sheet", r1: 1, c1: 1, r2: 2, c2: 2 });
    expect(parseFormula("='O''Brien'!A1")).toMatchObject({ sheet: "O'Brien" });
    expect(parseFormula("=A:A")).toMatchObject({ t: "ref", r2: -1, c1: 0, c2: 0 });
    expect(parseFormula("=2:3")).toMatchObject({ t: "ref", r1: 1, r2: 2, c2: -1 });
    expect(parseFormula("=Taxes")).toEqual({ t: "name", name: "Taxes" });
  });
});

describe("evaluation", () => {
  it("does arithmetic with Excel's precedence", () => {
    expect(calc("1+2*3")).toBe(7);
    expect(calc("(1+2)*3")).toBe(9);
    expect(calc("2^3^2")).toBe(64);
    expect(calc("-2^2")).toBe(4);
    expect(calc("10/4")).toBe(2.5);
    expect(calc("50%")).toBe(0.5);
    expect(calc("200*10%")).toBe(20);
    expect(calc('"a"&"b"&1')).toBe("ab1");
    expect(calc("1/0")).toBe(ERRORS["#DIV/0!"]);
    expect(calc("0^0")).toBe(ERRORS["#NUM!"]);
  });
  it("coerces like a spreadsheet", () => {
    expect(calc('"3"+4')).toBe(7);
    expect(calc('"abc"+1')).toBe(ERRORS["#VALUE!"]);
    expect(calc("TRUE+TRUE")).toBe(2);
    expect(calc("A1+1")).toBe(1);
    expect(calc('A1&"x"')).toBe("x");
    expect(parseNumeric("1,234.5")).toBe(1234.5);
    expect(parseNumeric("(5)")).toBe(-5);
    expect(parseNumeric("$12")).toBe(12);
    expect(parseNumeric("12abc")).toBeNull();
    expect(toNumber("x")).toBe(ERRORS["#VALUE!"]);
  });
  it("compares numbers, text and booleans", () => {
    expect(calc("1<2")).toBe(true);
    expect(calc('"a"="A"')).toBe(true);
    expect(calc('"a"<"b"')).toBe(true);
    expect(calc('1<"a"')).toBe(true);
    expect(calc("TRUE>5")).toBe(true);
    expect(calc("A1=0")).toBe(true);
    expect(calc('A1=""')).toBe(true);
    expect(calc("1<>2")).toBe(true);
  });
  it("reads cells, ranges and other sheets", () => {
    const wb = book({ Data: { A1: 2, A2: 3, A3: 5, B1: "=SUM(A1:A3)" }, Summary: { A1: "=Data!B1*2", A2: "='Data'!A3+1", A3: "=Nope!A1" } });
    expect(at(wb, "A1", "Summary")).toBe(20);
    expect(at(wb, "A2", "Summary")).toBe(6);
    expect(at(wb, "A3", "Summary")).toBe(ERRORS["#REF!"]);
  });
  it("evaluates defined names", () => {
    const wb = book({ S: { A1: 100, B1: "=Rate*A1", B2: "=Missing" } }, { names: { Rate: "S!$A$2", Total: "S!$A$1:$A$1" } });
    expect(at(wb, "B2")).toBe(ERRORS["#NAME?"]);
    wb.workbook.sheets[0]!.cells.set(cellKey(1, 0), { value: 0.5, style: 0 });
    wb.invalidate();
    expect(at(wb, "B1")).toBe(50);
  });
  it("collapses a range result to its first cell and broadcasts array math", () => {
    expect(calc("A1:A3", { A1: 7, A2: 8, A3: 9 })).toBe(7);
    expect(calc("SUMPRODUCT((A1:A3>7)*(B1:B3))", { A1: 7, A2: 8, A3: 9, B1: 1, B2: 10, B3: 100 })).toBe(110);
    expect(calc("SUM(A1:A3*2)", { A1: 1, A2: 2, A3: 3 })).toBe(12);
    expect(calc("SUM({1,2;3,4})")).toBe(10);
  });
  it("handles whole-column references against the used extent", () => {
    expect(calc("SUM(A:A)", { A1: 1, A2: 2, A5: 3, B1: 100 })).toBe(6 + 0);
    expect(calc("COUNTA(A:A)", { A1: "x", A4: 1 })).toBe(2);
  });
  it("breaks circular references instead of looping", () => {
    const wb = book({ S: { A1: "=B1+1", B1: "=A1+1" } });
    expect(at(wb, "A1")).toBe(2);
    expect(wb.stats().circular).toBe(true);
  });
  it("keeps the stored value for functions it does not implement", () => {
    const wb = book({ S: { A1: "=FANCYFUNC(1)", B1: "=A1+1" } });
    wb.workbook.sheets[0]!.cells.get(0)!.value = 41;
    expect(at(wb, "A1")).toBe(41);
    expect(at(wb, "B1")).toBe(42);
    expect(wb.stats()).toMatchObject({ approximate: 1, unsupported: ["FANCYFUNC"] });
  });
  it("keeps the stored value for formulas it cannot parse", () => {
    const wb = book({ S: { A1: "=Table1[Total]" } });
    wb.workbook.sheets[0]!.cells.get(0)!.value = 9;
    expect(at(wb, "A1")).toBe(9);
  });
});

describe("functions", () => {
  const data = { A1: 10, A2: 20, A3: 30, A4: "x", A5: null, B1: "a", B2: "b", B3: "a", B4: "b", B5: "a" } as const;
  const f = (formula: string) => calc(formula, data);
  it("aggregates and ignores text in ranges", () => {
    expect(f("SUM(A1:A5)")).toBe(60);
    expect(f("AVERAGE(A1:A5)")).toBe(20);
    expect(f("MIN(A1:A5)")).toBe(10);
    expect(f("MAX(A1:A5)")).toBe(30);
    expect(f("COUNT(A1:A5)")).toBe(3);
    expect(f("COUNTA(A1:A5)")).toBe(4);
    expect(f("COUNTBLANK(A1:A5)")).toBe(1);
    expect(f("MEDIAN(A1:A3)")).toBe(20);
    expect(f("SUM(1,2,TRUE)")).toBe(4);
    expect(f('SUM("x")')).toBe(ERRORS["#VALUE!"]);
    expect(f("AVERAGE(A4:A5)")).toBe(ERRORS["#DIV/0!"]);
    expect(f("LARGE(A1:A3,2)")).toBe(20);
    expect(f("SMALL(A1:A3,1)")).toBe(10);
    expect(f("RANK(20,A1:A3)")).toBe(2);
    expect(f("STDEV(A1:A3)")).toBe(10);
    expect(f("PRODUCT(A1:A2)")).toBe(200);
  });
  it("propagates errors from cells", () => {
    expect(calc("SUM(A1:A2)", { A1: 1, A2: "=1/0" })).toBe(ERRORS["#DIV/0!"]);
    expect(calc("IFERROR(SUM(A1:A2),0)", { A1: 1, A2: "=1/0" })).toBe(0);
  });
  it("rounds the way spreadsheets do", () => {
    expect(f("ROUND(2.5,0)")).toBe(3);
    expect(f("ROUND(-2.5,0)")).toBe(-3);
    expect(f("ROUND(1.005,2)")).toBe(1.01);
    expect(f("ROUND(1234,-2)")).toBe(1200);
    expect(f("ROUNDUP(1.21,1)")).toBe(1.3);
    expect(f("ROUNDDOWN(-1.29,1)")).toBe(-1.2);
    expect(f("INT(-1.5)")).toBe(-2);
    expect(f("TRUNC(-1.59,1)")).toBe(-1.5);
    expect(f("MOD(-3,2)")).toBe(1);
    expect(f("MOD(3,0)")).toBe(ERRORS["#DIV/0!"]);
    expect(f("CEILING(4.2,0.5)")).toBe(4.5);
    expect(f("FLOOR(4.7,0.5)")).toBe(4.5);
    expect(f("SQRT(-1)")).toBe(ERRORS["#NUM!"]);
    expect(f("POWER(2,10)")).toBe(1024);
    expect(f("ABS(-3)")).toBe(3);
  });
  it("branches lazily", () => {
    expect(f("IF(A1>5,\"big\",\"small\")")).toBe("big");
    expect(f("IF(A1>50,1/0,2)")).toBe(2);
    expect(f("IF(FALSE,1)")).toBe(false);
    expect(f("IFS(A1>50,1,A1>5,2)")).toBe(2);
    expect(f("IFS(A1>50,1)")).toBe(ERRORS["#N/A"]);
    expect(f("IFERROR(1/0,\"n/a\")")).toBe("n/a");
    expect(f("IFNA(NA(),0)")).toBe(0);
    expect(f("SWITCH(2,1,\"one\",2,\"two\",\"other\")")).toBe("two");
    expect(f("CHOOSE(2,\"a\",\"b\",\"c\")")).toBe("b");
    expect(f("AND(TRUE,A1>5)")).toBe(true);
    expect(f("OR(FALSE,A1>50)")).toBe(false);
    expect(f("NOT(TRUE)")).toBe(false);
    expect(f("ISBLANK(A5)")).toBe(true);
    expect(f("ISNUMBER(A1)")).toBe(true);
    expect(f("ISTEXT(A4)")).toBe(true);
    expect(f("ISERROR(1/0)")).toBe(true);
  });
  it("counts and sums with criteria", () => {
    expect(f('COUNTIF(B1:B5,"a")')).toBe(3);
    expect(f('COUNTIF(A1:A3,">15")')).toBe(2);
    expect(f('COUNTIF(A1:A3,">=20")')).toBe(2);
    expect(f('COUNTIF(B1:B5,"<>a")')).toBe(2);
    expect(f('COUNTIF(B1:B5,"A")')).toBe(3);
    expect(f('COUNTIF(A1:A3,20)')).toBe(1);
    expect(f('SUMIF(B1:B5,"a",A1:A5)')).toBe(10 + 30 + 0);
    expect(f('SUMIF(A1:A3,">15")')).toBe(50);
    expect(f('SUMIFS(A1:A3,B1:B3,"a",A1:A3,">5")')).toBe(40);
    expect(f('COUNTIFS(B1:B5,"a",A1:A5,">5")')).toBe(2);
    expect(f('AVERAGEIF(B1:B3,"a",A1:A3)')).toBe(20);
    expect(f('MAXIFS(A1:A3,B1:B3,"a")')).toBe(30);
    expect(f('MINIFS(A1:A3,B1:B3,"a")')).toBe(10);
    expect(f('COUNTIF(B1:B5,"a*")')).toBe(3);
    expect(f('SUMIFS(A1:A3,B1:B2,"a")')).toBe(ERRORS["#VALUE!"]);
  });
  it("looks things up", () => {
    const t = { A1: "id", B1: "name", A2: 1, B2: "Ada", A3: 2, B3: "Grace", A4: 3, B4: "Edsger", D1: 2 };
    const g = (formula: string) => calc(formula, t);
    expect(g("VLOOKUP(2,A2:B4,2,FALSE)")).toBe("Grace");
    expect(g("VLOOKUP(D1,A2:B4,2,0)")).toBe("Grace");
    expect(g("VLOOKUP(9,A2:B4,2,FALSE)")).toBe(ERRORS["#N/A"]);
    expect(g("VLOOKUP(2.5,A2:B4,2,TRUE)")).toBe("Grace");
    expect(g("VLOOKUP(2,A2:B4,5,FALSE)")).toBe(ERRORS["#REF!"]);
    expect(g("INDEX(B2:B4,2)")).toBe("Grace");
    expect(g("INDEX(A2:B4,3,2)")).toBe("Edsger");
    expect(g("MATCH(3,A2:A4,0)")).toBe(3);
    expect(g("MATCH(2.5,A2:A4,1)")).toBe(2);
    expect(g("INDEX(B2:B4,MATCH(3,A2:A4,0))")).toBe("Edsger");
    expect(g('XLOOKUP("Grace",B2:B4,A2:A4)')).toBe(2);
    expect(g('XLOOKUP("Nobody",B2:B4,A2:A4,"none")')).toBe("none");
    expect(g("ROWS(A2:B4)")).toBe(3);
    expect(g("COLUMNS(A2:B4)")).toBe(2);
    expect(g("ROW(C7)")).toBe(7);
    expect(g("COLUMN(C7)")).toBe(3);
  });
  it("works with text", () => {
    expect(f('LEN("héllo")')).toBe(5);
    expect(f('UPPER("ab")&LOWER("CD")')).toBe("ABcd");
    expect(f('PROPER("hello wORLD")')).toBe("Hello World");
    expect(f('TRIM("  a   b ")')).toBe("a b");
    expect(f('LEFT("abcdef",2)&RIGHT("abcdef",2)&MID("abcdef",3,2)')).toBe("abefcd");
    expect(f('SUBSTITUTE("a-b-c","-","+")')).toBe("a+b+c");
    expect(f('SUBSTITUTE("a-b-c","-","+",2)')).toBe("a-b+c");
    expect(f('FIND("c","abc")')).toBe(3);
    expect(f('SEARCH("C","abc")')).toBe(3);
    expect(f('FIND("x","abc")')).toBe(ERRORS["#VALUE!"]);
    expect(f('CONCAT("a",1,TRUE)')).toBe("a1TRUE");
    expect(f('TEXTJOIN(", ",TRUE,"a","","b")')).toBe("a, b");
    expect(f('REPT("ab",3)')).toBe("ababab");
    expect(f('VALUE("1,200")')).toBe(1200);
    expect(f('TEXT(0.353,"0.0%")')).toBe("35.3%");
    expect(f('TEXT(1234.5,"#,##0.00")')).toBe("1,234.50");
    expect(f('TEXT(46217,"yyyy-mm-dd")')).toBe("2026-07-14");
    expect(f('EXACT("a","A")')).toBe(false);
  });
  it("does date math", () => {
    expect(f("DATE(2026,7,14)")).toBe(46217);
    expect(f("DATE(2026,14,1)")).toBe(f("DATE(2027,2,1)"));
    expect(f("YEAR(46217)&\"-\"&MONTH(46217)&\"-\"&DAY(46217)")).toBe("2026-7-14");
    expect(f("WEEKDAY(46217)")).toBe(3);
    expect(f("WEEKDAY(46217,2)")).toBe(2);
    expect(f("EDATE(46217,1)")).toBe(f("DATE(2026,8,14)"));
    expect(f("EOMONTH(46217,0)")).toBe(f("DATE(2026,7,31)"));
    expect(f("EOMONTH(DATE(2026,1,31),1)")).toBe(f("DATE(2026,2,28)"));
    expect(f("DAYS(46217,46200)")).toBe(17);
    expect(f("DATEDIF(DATE(2024,1,15),DATE(2026,7,14),\"M\")")).toBe(29);
    expect(f("TODAY()")).toBe(46217);
    expect(f("HOUR(0.75)")).toBe(18);
  });
  it("does loan math", () => {
    expect(Number(f("PMT(0.05/12,360,200000)"))).toBeCloseTo(-1073.64, 2);
    expect(Number(f("FV(0.06/12,10,-200,-500)"))).toBeCloseTo(2571.18, 1);
    expect(Number(f("NPV(0.1,100,100)"))).toBeCloseTo(173.55, 2);
    expect(Number(calc("IRR(A1:A3)", { A1: -100, A2: 60, A3: 60 }))).toBeCloseTo(0.1307, 3);
    expect(Number(f("PV(0.05,10,-100)"))).toBeCloseTo(772.17, 2);
  });
  it("rejects wrong argument counts", () => {
    expect(f("ROUND(1)")).toBe(ERRORS["#VALUE!"]);
    expect(f("ABS(1,2)")).toBe(ERRORS["#VALUE!"]);
  });
});

describe("typed input and editing", () => {
  it("reads typed input the way Excel does", () => {
    expect(parseInput("")).toEqual({ kind: "blank" });
    expect(parseInput("=A1+1")).toEqual({ kind: "formula", formula: "A1+1" });
    expect(parseInput("=")).toEqual({ kind: "value", value: "=" });
    expect(parseInput("'123")).toEqual({ kind: "value", value: "123" });
    expect(parseInput("42")).toMatchObject({ kind: "value", value: 42 });
    expect(parseInput("1,234.5")).toMatchObject({ value: 1234.5 });
    expect(parseInput("12%")).toEqual({ kind: "value", value: 0.12, numFmtId: 9 });
    expect(parseInput("TRUE")).toEqual({ kind: "value", value: true });
    expect(parseInput("hello")).toEqual({ kind: "value", value: "hello" });
    expect(parseInput("2026-07-14")).toEqual({ kind: "value", value: 46217, numFmtId: 14 });
    expect(parseInput("7/14/2026")).toEqual({ kind: "value", value: 46217, numFmtId: 14 });
    expect(parseInput("2026-02-31")).toEqual({ kind: "value", value: "2026-02-31" });
    expect(parseInput("#N/A")).toMatchObject({ value: ERRORS["#N/A"] });
  });
  it("recalculates dependents after an edit and can undo it", () => {
    const wb = book({ S: { A1: 2, A2: 3, A3: "=A1*A2", A4: "=A3+1" } });
    const sheet = wb.workbook.sheets[0]!;
    expect(at(wb, "A4")).toBe(7);
    const before = setInput(wb, sheet, 0, 0, parseInput("10"));
    expect(at(wb, "A3")).toBe(30);
    expect(at(wb, "A4")).toBe(31);
    restoreCell(wb, sheet, 0, 0, before);
    expect(at(wb, "A4")).toBe(7);
    setInput(wb, sheet, 5, 2, parseInput("=A1+100"));
    expect(sheet.rows).toBe(6);
    expect(sheet.cols).toBe(3);
    expect(at(wb, "C6")).toBe(102);
  });
  it("applies a percent or date format to a General cell when typed that way", () => {
    const wb = book({ S: { A1: 0 } });
    const sheet = wb.workbook.sheets[0]!;
    setInput(wb, sheet, 0, 0, parseInput("12%"));
    expect(wb.workbook.styles.added).toEqual([{ base: 0, numFmtId: 9 }]);
    expect(wb.format(sheet, 0, 0).text).toBe("12%");
  });
  it("clearing keeps a styled cell so its formatting survives", () => {
    const wb = book({ S: { A1: 5 } });
    const sheet = wb.workbook.sheets[0]!;
    sheet.cells.get(0)!.style = 3;
    setInput(wb, sheet, 0, 0, parseInput(""));
    expect(sheet.cells.get(0)).toEqual({ value: null, style: 3 });
    sheet.cells.get(0)!.style = 0;
    setInput(wb, sheet, 0, 0, parseInput(""));
    expect(sheet.cells.has(0)).toBe(false);
  });
  it("reports which stored values change when everything is recalculated", () => {
    const wb = book({ S: { A1: 2, B1: "=A1*2" } });
    const sheet = wb.workbook.sheets[0]!;
    sheet.cells.get(1)!.value = 4; // stored value from the file
    expect(wb.recalculateAll()).toEqual([]);
    setInput(wb, sheet, 0, 0, parseInput("5"));
    const changed = wb.recalculateAll();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ row: 0, col: 1, value: 10 });
    wb.commit(changed);
    expect(wb.recalculateAll()).toEqual([]);
  });
});

describe("the calculator class", () => {
  it("is exported for the viewer", () => {
    expect(Calculator).toBeTypeOf("function");
  });
});
