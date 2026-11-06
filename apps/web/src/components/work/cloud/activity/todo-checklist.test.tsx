import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodoChecklist } from "./todo-checklist";
import type { TodoList } from "@lori-enterprise/contracts";
afterEach(cleanup);
const list: TodoList = { revision: 1, todos: [
  { id: "read", content: "Read sources", status: "completed" },
  { id: "report", content: "Create report", status: "in_progress" },
] };
describe("task progress", () => {
  it("shows compact progress without implementation copy or editable checkboxes", () => {
    const { rerender } = render(<TodoChecklist list={list} working />);
    expect(screen.getByRole("button", { name: "Tasks, 1 of 2 completed" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("In progress:")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("Progress reported by Lori")).toBeNull();
    rerender(<TodoChecklist list={list} />);
    expect(screen.queryByText("Work paused")).toBeNull();
    expect(screen.queryByText("In progress:")).toBeNull();
    expect(screen.getByText("Pending:")).toBeTruthy();
  });
  it("preserves an explicit collapsed choice across updates, reordering and additions", () => {
    const { rerender } = render(<TodoChecklist list={list} working />);
    fireEvent.click(screen.getByRole("button"));
    rerender(<TodoChecklist list={{ revision: 2, todos: [...list.todos].reverse() }} />);
    expect(screen.queryByRole("list")).toBeNull();
    rerender(<TodoChecklist list={{ revision: 3, todos: [...list.todos, { id: "new", content: "Check report", status: "pending" }] }} />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
  it("does not collapse while the reader is watching the last task complete", () => {
    const { rerender } = render(<TodoChecklist list={list} working />);
    rerender(<TodoChecklist list={{ revision: 2, todos: list.todos.map(todo => ({ ...todo, status: "completed" })) }} />);
    expect(screen.getByRole("button", { name: "Tasks, 2 of 2 completed" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
  it("starts saved completed lists collapsed and resets for a replacement plan", () => {
    const { rerender } = render(<TodoChecklist list={{ revision: 2, todos: [list.todos[0]!] }} />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    rerender(<TodoChecklist list={{ revision: 3, todos: [{ id: "new", content: "New task", status: "pending" }] }} />);
    expect(screen.getByRole("list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    rerender(<TodoChecklist list={{ revision: 4, todos: [] }} />);
    expect(screen.getByRole("status").textContent).toBe("Tasks cleared");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<TodoChecklist list={list} />);
    expect(screen.getByRole("list")).toBeTruthy();
  });
  it("keeps the disclosure target stable and renders long or markup-like content as text", () => {
    const content = "<script>example</script>" + "longfilename".repeat(15);
    const { rerender, container } = render(<TodoChecklist list={{ revision: 1, todos: [{ id: "long", content, status: "pending" }] }} />);
    const target = screen.getByRole("button").getAttribute("aria-controls")!;
    expect(document.getElementById(target)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(content)).toBeTruthy();
    rerender(<TodoChecklist list={{ revision: 2, todos: [{ id: "long", content, status: "completed" }] }} />);
    expect(screen.getByRole("button").getAttribute("aria-controls")).toBe(target);
  });
});
