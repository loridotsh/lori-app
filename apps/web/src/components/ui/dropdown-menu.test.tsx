import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger,
} from "./dropdown-menu";

it("opens without scrollbar compensation or blocking the surrounding page", async () => {
  const outside = vi.fn();
  render(<>
    <DropdownMenu><DropdownMenuTrigger>Open menu</DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuItem>Action</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <button onClick={outside}>Outside action</button>
  </>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open menu" }));
  await screen.findByRole("menu");
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(screen.getByRole("button", { name: "Outside action" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Outside action" }));
  expect(outside).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("retains keyboard selection and Escape focus restoration", async () => {
  const change = vi.fn();
  render(<DropdownMenu><DropdownMenuTrigger>Choose</DropdownMenuTrigger><DropdownMenuContent>
    <DropdownMenuRadioGroup value="one" onValueChange={change}>
      <DropdownMenuRadioItem value="one">First</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="two">Second</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  </DropdownMenuContent></DropdownMenu>);
  const user = userEvent.setup(), trigger = screen.getByRole("button", { name: "Choose" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("menu");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(change).toHaveBeenCalledWith("two");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

it("portals submenus outside the parent menu's scrolling box", async () => {
  render(<DropdownMenu defaultOpen><DropdownMenuTrigger>Actions</DropdownMenuTrigger><DropdownMenuContent>
    <DropdownMenuSub><DropdownMenuSubTrigger>More</DropdownMenuSubTrigger><DropdownMenuSubContent>
      <DropdownMenuItem>Nested action</DropdownMenuItem>
    </DropdownMenuSubContent></DropdownMenuSub>
  </DropdownMenuContent></DropdownMenu>);
  const parent = await screen.findByRole("menu");
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "More" }), { key: "ArrowRight" });
  const nested = await screen.findByRole("menuitem", { name: "Nested action" });
  expect(parent.contains(nested)).toBe(false);
});
