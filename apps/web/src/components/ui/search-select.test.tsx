import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { SearchSelect } from "./search-select";

const options = [
  { value: "one", label: "Alex", description: "alex@first.test", group: "Members" },
  { value: "two", label: "Alex", description: "alex@second.test", group: "Members" },
  { value: "taken", label: "Already added", group: "Members", disabled: true },
  { value: "team", label: "Design team", description: "All team members", group: "Teams" },
];
// Happy DOM has no layout; provide an on-screen anchor for collision handling.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 16, 320, 40));
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 768 });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, "clientWidth");
  Reflect.deleteProperty(document.documentElement, "clientHeight");
});

it("searches email addresses and selects the correct person without a native select", async () => {
  const onChange = vi.fn();
  const { container } = render(<SearchSelect label="Member or team" value="" options={options} onChange={onChange} />);
  expect(container.querySelector("select")).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Member or team" }));
  const search = await screen.findByRole("combobox", { name: "Search member or team" });
  fireEvent.change(search, { target: { value: "second.test" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("two");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Member or team" }));
});

it("skips disabled options during keyboard navigation and restores focus on Escape", async () => {
  const onChange = vi.fn();
  render(<SearchSelect label="Choice" value="two" options={options} onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  const search = await screen.findByRole("combobox", { name: "Search choice" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  const activeId = search.getAttribute("aria-activedescendant")!;
  expect(document.getElementById(activeId)?.textContent).toContain("Design team");
  fireEvent.click(screen.getByRole("option", { name: "Already added" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Choice" }));
});

it("Tab closes the popup and continues to the next form control", async () => {
  const user = userEvent.setup();
  render(<><SearchSelect label="Choice" value="" options={options} onChange={() => {}} /><button type="button">Add</button></>);
  await user.click(screen.getByRole("combobox", { name: "Choice" }));
  await screen.findByRole("combobox", { name: "Search choice" });
  await user.tab();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
});

it("shows a recoverable empty search and clears the filter on reopen", async () => {
  render(<SearchSelect label="Choice" value="" options={options} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  const search = await screen.findByRole("combobox", { name: "Search choice" });
  fireEvent.change(search, { target: { value: "missing person" } });
  expect(screen.getByRole("status").textContent).toBe("No matching options.");
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  await screen.findByRole("listbox");
  expect(screen.getAllByRole("option")).toHaveLength(4);
});

it("closes an open selector when its permission-dependent control becomes disabled", async () => {
  function Fixture() {
    const [disabled, setDisabled] = useState(false);
    return <><SearchSelect label="Choice" value="" options={options} disabled={disabled} onChange={() => {}} /><button onClick={() => setDisabled(true)}>Revoke edit access</button></>;
  }
  render(<Fixture />);
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  await screen.findByRole("listbox");
  fireEvent.click(screen.getByRole("button", { name: "Revoke edit access" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect((screen.getByRole("combobox", { name: "Choice" }) as HTMLButtonElement).disabled).toBe(true);
});

it("withdraws portalled options when the owning form becomes locked", async () => {
  const field = <SearchSelect label="Choice" value="" options={options} onChange={() => {}} />;
  const { rerender } = render(<div>{field}</div>);
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  await screen.findByRole("listbox");
  rerender(<div inert>{field}</div>);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
});

it("opens from the keyboard without scrolling the page", async () => {
  render(<SearchSelect label="Choice" value="" options={options} onChange={() => {}} />);
  const trigger = screen.getByRole("combobox", { name: "Choice" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const search = await screen.findByRole("combobox", { name: "Search choice" });
  expect(document.activeElement).toBe(search);
  expect(document.getElementById(search.getAttribute("aria-activedescendant")!)?.textContent).toContain("alex@first.test");
});

it("scrolls only the option list when a keyboard selection is outside its visible area", async () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const { container } = render(<SearchSelect label="Choice" value="" options={options} onChange={() => {}} />);
  container.scrollTop = 140;
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  const list = await screen.findByRole("listbox");
  const search = screen.getByRole("combobox", { name: "Search choice" });
  Object.defineProperty(list, "getBoundingClientRect", { value: () => new DOMRect(16, 100, 320, 100) });
  Object.defineProperty(screen.getAllByRole("option")[0]!, "getBoundingClientRect", { value: () => new DOMRect(16, 250, 320, 40) });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(list.scrollTop).toBe(90);
  expect(container.scrollTop).toBe(140);
  expect(scrollIntoView).not.toHaveBeenCalled();
});

it("withdraws choices when an ancestor is hidden by CSS", async () => {
  const field = <SearchSelect label="Choice" value="" options={options} onChange={() => {}} />;
  const view = render(<div>{field}</div>);
  fireEvent.click(screen.getByRole("combobox", { name: "Choice" }));
  await screen.findByRole("listbox");
  view.rerender(<div style={{ display: "none" }}>{field}</div>);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
});
