import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConversationStatus } from "./conversation-status";

afterEach(cleanup);
it.each([
  ["queued", "Queued"], ["running", "Agent running"],
  ["awaitingApproval", "Waiting for approval"], ["failed", "Run failed"],
  ["interrupted", "Run interrupted"],
] as const)("describes %s without relying on color", (status, label) => {
  render(<ConversationStatus status={status} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByTitle(label)).toBeTruthy();
});
it("reserves the same space for idle and active conversations", () => {
  const { container, rerender } = render(<ConversationStatus status="completed" />);
  const classes = container.firstElementChild?.className;
  expect(container.textContent).toBe("");
  rerender(<ConversationStatus status="running" />);
  expect(container.firstElementChild?.className).toBe(classes);
});
