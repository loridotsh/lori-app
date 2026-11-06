import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../../../packages/contracts/fixtures/fixtures.json";
import { CloudVisualActivity as VisualActivity, VisualBoundary, sourceMeta } from "./visual-activity";
import { VisualChart, chartDomain } from "./VisualChart";
import { VisualTable } from "./VisualTable";
import { parseVisual } from "@lori-enterprise/contracts";
import type { CloudToolInvocation as ToolActivity } from "@lori-enterprise/contracts";
import type { CalculatorBlock, ChartBlock } from "@lori-enterprise/contracts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const visual = parseVisual(fixture)!;
/** Numbers follow the viewer's locale, so 160,000 reads 1,60,000 in India. */
const localNumber = (value: number) => new Intl.NumberFormat().format(value);
function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  const result = overrides.output as { visual?: unknown } | undefined;
  return { id: "visual", runId: "run", roundId: "round", callId: "call", actionHash: "hash", name: "present_visual", status: "completed", textOffset: 0,
    createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", arguments: fixture,
    ...overrides,
    ...(result?.visual ? { arguments: result.visual as Record<string, unknown> } : {}),
    output: overrides.output === null ? null : { kind: "cloud_visual", presented: true },
  };
}

describe("Work inline visuals", () => {
  it("renders the complete catalog as accessible native content, without embedded code", () => {
    const { container } = render(<VisualActivity item={activity()} />);
    expect(screen.getByRole("region", { name: fixture.title })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Two paths to growth/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Compare your options/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Customers" })).toBeTruthy();
    expect(container.querySelector("iframe, script, object, embed")).toBeNull();
  });
  it("updates calculator outputs immediately and preserves inputs across subsequent message revisions", () => {
    const { rerender } = render(<VisualActivity item={activity()} />);
    const output = () => screen.getByLabelText("Monthly revenue");
    expect(output().textContent).toContain(localNumber(96_000));
    fireEvent.change(screen.getByRole("slider", { name: "Adjust Customers" }), { target: { value: "200" } });
    expect(output().textContent).toContain(localNumber(160_000));
    rerender(<VisualActivity item={activity({ output: structuredClone({ visual: fixture }) })} />);
    expect((screen.getByRole("spinbutton", { name: "Customers" }) as HTMLInputElement).value).toBe("200");
    expect(output().textContent).toContain(localNumber(160_000));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Customers" }), { target: { value: "" } });
    expect(output().textContent).toBe("Check inputs");
    expect(screen.getByRole("spinbutton", { name: "Customers" }).getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Reset Explore the monthly revenue" }));
    expect(output().textContent).toContain("96,000");
  });
  it("keeps runtime division by zero readable without crashing or showing Infinity", () => {
    const block = structuredClone(visual.blocks[2]) as CalculatorBlock;
    block.outputs = [{ label: "Per customer", expression: [100, "customers", "/"] }];
    render(<VisualActivity item={activity({ output: { visual: { ...visual, blocks: [block] } } })} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Customers" }), { target: { value: "0" } });
    expect(screen.getByLabelText("Per customer").textContent).toBe("Undefined for these inputs");
  });
  it("renders familiar calculator formulas and keeps automatic repairs quiet", () => {
    const { rerender } = render(<VisualActivity item={activity({ status: "failed", output: null })} />);
    expect(screen.getByRole("status").textContent).toContain("couldn’t be displayed");
    expect(screen.getByText(/Ask Lori/)).toBeTruthy();
    const block = structuredClone(visual.blocks[2]) as CalculatorBlock;
    block.outputs = [{ label: "Monthly revenue", expression: "customers * price" }];
    rerender(<VisualActivity item={activity({ output: { visual: { ...visual, blocks: [block] } } })} />);
    expect(screen.getByLabelText("Monthly revenue").textContent).toBe("96,000");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Customers" }), { target: { value: "250" } });
    expect(screen.getByLabelText("Monthly revenue").textContent).toBe(localNumber(200_000));
  });
  it("shows every step at once as an ordered, labelled sequence", () => {
    render(<VisualActivity item={activity()} />);
    const list = screen.getByRole("list", { name: "How to read this scenario steps" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(screen.getByRole("heading", { name: "Step 1: Start with your assumptions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Step 2: Compare the growth paths" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Step 3: Review the limitations" })).toBeTruthy();
    expect(screen.getByText(/Revenue is not profit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next step|Previous step/ })).toBeNull();
  });
  it("summarises source references as a short site and note line", () => {
    expect(sourceMeta("https://www.anthropic.com/news/donating-agent-skills; 2026-10-22")).toBe("anthropic.com · 2026-10-22");
    expect(sourceMeta("https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices;\n  accessed 2026-10-24")).toBe("docs.anthropic.com · accessed 2026-10-24");
    expect(sourceMeta("Newsroom (https://www.anthropic.com/news), read 2026-10-24")).toBe("anthropic.com · Newsroom, read 2026-10-24");
    expect(sourceMeta("https://www.anthropic.com/news")).toBe("anthropic.com");
    expect(sourceMeta("q3-finance.xlsx · sheet Summary")).toBe("q3-finance.xlsx · sheet Summary");
  });
  it("only renders validated completed results, with quiet pending and failure states", () => {
    const { rerender } = render(<VisualActivity item={activity({ status: "running", output: null })} />);
    expect(screen.getByRole("status").textContent).toBe("Preparing a visual");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    rerender(<VisualActivity item={activity({ status: "completed", output: { visual: { ...fixture, version: 99 } } })} />);
    expect(screen.getByText(/couldn’t be displayed/)).toBeTruthy();
    expect(screen.getByText(fixture.summary)).toBeTruthy();
    rerender(<VisualActivity item={activity({ status: "unknown", output: null })} />);
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
  });
  it("treats hostile display text as text and survives renderer errors", () => {
    const source = structuredClone(fixture);
    source.title = "<img src=x onerror=alert(1)>";
    const { container, unmount } = render(<VisualActivity item={activity({ output: { visual: source } })} />);
    expect(screen.getByRole("heading", { name: source.title })).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    unmount();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never { throw new Error("render failure"); }
    render(<VisualBoundary summary="Preserved takeaway"><Broken /></VisualBoundary>);
    expect(screen.getByText("Preserved takeaway")).toBeTruthy();
    expect(screen.getByText(/couldn’t be displayed/)).toBeTruthy();
    spy.mockRestore();
  });
  it("copies an explicit original snapshot and handles clipboard rejection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<VisualActivity item={activity()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy visual as text" }));
    expect(await screen.findByText("Visual copied with its original data and default inputs.")).toBeTruthy();
    expect(writeText.mock.calls[0]![0]).toContain("Monthly revenue: 96000 INR");
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy visual as text" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not copy. Try again.");
    vi.unstubAllGlobals();
  });
});

describe("visual data exploration", () => {
  it("sorts numeric data, pages bounded rows, and resets pagination after filtering", () => {
    render(<VisualTable block={{ type: "table", title: "Plans", columns: ["Name", "Price"], rows: Array.from({ length: 11 }, (_, i) => [`Plan ${i + 1}`, (i + 1) * 10]) }} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: "Next page of Plans" }));
    expect(screen.getByText("9–11 of 11 rows")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Price" }));
    fireEvent.click(screen.getByRole("button", { name: "Price" }));
    expect(within(table).getAllByRole("row")[1]!.textContent).toBe("Plan 11110");
    expect(screen.getByRole("columnheader", { name: "Price" }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Plans" }), { target: { value: "Plan 10" } });
    expect(screen.getByText("1–1 of 1 rows")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unmatched" } });
    expect(screen.getByText(/No matching rows/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.getByText("1–8 of 11 rows")).toBeTruthy();
  });
  it("allows exact-value inspection and series toggling while keeping a visible series", () => {
    render(<VisualChart block={visual.blocks[1] as ChartBlock} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Inspect Two paths to growth" }), { target: { value: "5" } });
    expect(screen.getByText("368")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Faster" }));
    expect(screen.queryByText("368")).toBeNull();
    expect((screen.getByRole("button", { name: "Steady" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "View data" }));
    const data = screen.getByRole("table", { name: /Two paths to growth data/ });
    expect(within(data).getByText("368")).toBeTruthy();
    expect(within(data).getAllByRole("row")).toHaveLength(7);
  });
  it("keeps the chart disclosure target present and exposes only expanded data", () => {
    const { container } = render(<VisualChart block={visual.blocks[1] as ChartBlock} />);
    const button = screen.getByRole("button", { name: "View data" });
    const region = container.querySelector(`[id="${button.getAttribute("aria-controls")}"]`) as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.hidden).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(button);
    expect(region.hidden).toBe(false);
    expect(screen.getByRole("table")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide data" }));
    expect(region.hidden).toBe(true);
    expect(container.contains(region)).toBe(true);
  });
  it("handles negative, zero, tiny, and single-point charts with finite geometry", () => {
    expect(chartDomain([0, 0])).toEqual([0, 1]);
    expect(chartDomain([-4, -1])[1]).toBe(0);
    for (const values of [[0], [-5, 2], [0.00000001], [1e12, -1e12]]) {
      const block: ChartBlock = { type: "chart", title: "Values", chartType: "bar", xLabel: "Sample", yLabel: "Units", labels: values.map((_, i) => String(i)), series: [{ name: "Values", values }] };
      const { container, unmount } = render(<VisualChart block={block} />);
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
      expect(container.querySelectorAll("rect[rx]")).toHaveLength(values.length);
      unmount();
    }
  });
});
