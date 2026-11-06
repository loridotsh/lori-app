import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChangedFiles } from "./changed-files";

afterEach(cleanup);

it("uses readable artifact titles and keeps duplicate filenames linked to their own paths", () => {
  const open = vi.fn();
  render(<ChangedFiles paths={["finance/runway.lori.json", "plans/runway.lori.json"]} onOpen={open}
    artifactTitles={new Map([["finance/runway.lori.json", "Cash Runway Calculator"], ["plans/runway.lori.json", "Funding Plan"]])} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Cash Runway Calculator in workspace" }));
  expect(open).toHaveBeenLastCalledWith("finance/runway.lori.json");
  fireEvent.click(screen.getByRole("button", { name: "Open Funding Plan in workspace" }));
  expect(open).toHaveBeenLastCalledWith("plans/runway.lori.json");
  expect(screen.getAllByText("Open in workspace")).toHaveLength(2);
  expect(screen.queryByText("runway.lori.json")).toBeNull();
});

it("keeps all twenty outputs reachable, including duplicate names and long paths", () => {
  const paths = Array.from({ length: 20 }, (_, i) => `region-${i}/${"quarterly-".repeat(12)}report.xlsx`);
  const open = vi.fn();
  render(<ChangedFiles paths={paths} onOpen={open} />);
  const section = within(screen.getByRole("region", { name: "Files from this response" }));
  expect(section.getAllByRole("button", { name: /^Open preview/ })).toHaveLength(4);
  const toggle = section.getByRole("button", { name: "Show more (16)" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeTruthy();
  fireEvent.click(toggle);
  const buttons = section.getAllByRole("button", { name: /^Open preview/ });
  expect(buttons).toHaveLength(20);
  buttons.forEach((button, index) => {
    expect(button.getAttribute("aria-label")).toBe(`Open preview of ${paths[index]}`);
    fireEvent.click(button);
    expect(open).toHaveBeenLastCalledWith(paths[index]);
  });
  fireEvent.click(section.getByRole("button", { name: "Show less" }));
  expect(section.getAllByRole("button", { name: /^Open preview/ })).toHaveLength(4);
  expect(open).toHaveBeenCalledTimes(20);
});

it("shows small collections in full without a disclosure control", () => {
  const view = render(<ChangedFiles paths={[]} onOpen={vi.fn()} />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(<ChangedFiles paths={["report.pdf"]} onOpen={vi.fn()} />);
  expect(screen.getByText("1 file")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  view.rerender(<ChangedFiles paths={["a.txt", "b.txt", "c.txt", "d.txt"]} onOpen={vi.fn()} />);
  expect(screen.getAllByRole("button")).toHaveLength(4);
});
