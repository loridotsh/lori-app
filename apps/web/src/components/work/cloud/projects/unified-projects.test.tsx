import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProject, PersonalProject, PersonalProjectCapabilities } from "@lori-enterprise/contracts";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { NewProjectMenu } from "./new-project-menu";
import { creationOptions } from "./project-creation";
import { ProjectNavigation, type ProjectNavigationContext } from "./project-navigation";

vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<typeof CloudApiModule>()), cloudApi: vi.fn() }));

const team = (id: string, name: string, updatedAt: string) => ({ id, name, status: "active", accessRevision: 1, updatedAt, access: { actions: ["read", "chat"] } }) as unknown as CloudProject;
const mine = (id: string, name: string, updatedAt: string, over: Partial<PersonalProject> = {}): PersonalProject => ({
  id, name, description: "", status: "active", revision: 1, createdAt: updatedAt, updatedAt, archivedAt: null, deletedAt: null, purgeAfter: null, conversationCount: 0, referenceCount: 0, ...over,
});
const personalCaps = (over: Partial<PersonalProjectCapabilities> = {}): PersonalProjectCapabilities => ({ version: 1, available: true, canCreate: true, source: "everyone", count: 2, limit: 100, canAdminister: false, recoveryDays: 30, ...over });
const context: ProjectNavigationContext = { conversationId: null, conversations: [], disabled: false, openConversation: vi.fn(), newConversation: vi.fn() };
const handlers = { activeProjectId: null, panelProjectId: null, refreshKey: "0", onOpen: vi.fn(), onNew: vi.fn(), onSettings: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cloudApi).mockResolvedValue({ conversations: [], nextCursor: null });
});
afterEach(cleanup);

describe("creationOptions", () => {
  const teamCaps = (canCreate: boolean, available = true) => ({ available, canCreate });
  it("offers each kind the member may create, personal first", () => {
    expect(creationOptions(teamCaps(true), personalCaps()).map(option => option.kind)).toEqual(["personal", "team"]);
  });
  it("omits a kind the member has no permission for, rather than showing it disabled", () => {
    expect(creationOptions(teamCaps(false), personalCaps()).map(option => option.kind)).toEqual(["personal"]);
    expect(creationOptions(teamCaps(true), personalCaps({ canCreate: false, source: "none" })).map(option => option.kind)).toEqual(["team"]);
    expect(creationOptions(teamCaps(true), personalCaps({ canCreate: false, source: "blocked" })).map(option => option.kind)).toEqual(["team"]);
    expect(creationOptions(teamCaps(false), personalCaps({ canCreate: false, source: "none" }))).toEqual([]);
  });
  it("omits kinds the server cannot serve, including an older server without personal projects", () => {
    expect(creationOptions(teamCaps(true, false), null)).toEqual([]);
    expect(creationOptions(null, personalCaps({ available: false, source: "unavailable", canCreate: false }))).toEqual([]);
    expect(creationOptions(teamCaps(true), null).map(option => option.kind)).toEqual(["team"]);
    expect(creationOptions(undefined, undefined)).toEqual([]);
  });
  it("keeps a permitted-but-limited personal option visible with the reason", () => {
    const [option] = creationOptions(teamCaps(false), personalCaps({ canCreate: false, count: 100, limit: 100, source: "organization_admin" }));
    expect(option).toMatchObject({ kind: "personal", disabledReason: expect.stringContaining("100 of 100") });
  });
});

describe("NewProjectMenu", () => {
  const personalOption = { kind: "personal" as const, label: "Personal project", description: "Private to you" };
  const teamOption = { kind: "team" as const, label: "Team project", description: "Shared" };
  it("renders nothing without any permitted kind", () => {
    const { container } = render(<NewProjectMenu options={[]} onChoose={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
  it("creates directly when only one kind is available", async () => {
    const onChoose = vi.fn();
    render(<NewProjectMenu options={[personalOption]} onChoose={onChoose} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "New personal project" }));
    expect(onChoose).toHaveBeenCalledWith("personal");
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("opens a small menu to choose between kinds", async () => {
    const onChoose = vi.fn();
    render(<NewProjectMenu options={[personalOption, teamOption]} onChoose={onChoose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Personal projectPrivate to you", "Team projectShared"]);
    await user.click(within(menu).getByRole("menuitem", { name: /Team project/ }));
    expect(onChoose).toHaveBeenCalledWith("team");
  });
  it("shows the limit instead of letting a limited kind be chosen", async () => {
    const onChoose = vi.fn();
    render(<NewProjectMenu options={[{ ...personalOption, disabledReason: "You have 100 of 100 personal projects." }, teamOption]} onChoose={onChoose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New project" }));
    const item = await screen.findByRole("menuitem", { name: /Personal project/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(within(item).getByText("You have 100 of 100 personal projects.")).toBeTruthy();
    await user.click(item);
    expect(onChoose).not.toHaveBeenCalled();
  });
  it("keeps a lone limited kind in the menu so the reason is readable, and honors disabled", async () => {
    const { rerender } = render(<NewProjectMenu options={[{ ...personalOption, disabledReason: "At the limit." }]} onChoose={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "New project" }));
    expect(await screen.findByText("At the limit.")).toBeTruthy();
    rerender(<NewProjectMenu options={[personalOption, teamOption]} disabled onChoose={vi.fn()} />);
    expect((screen.getByRole("button", { name: "New project" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the unified Projects list", () => {
  const render_ = (over: Partial<Parameters<typeof ProjectNavigation>[0]> = {}) =>
    render(<ProjectNavigation projects={[team("t1", "Team launch", "2026-10-02T00:00:00Z"), team("t2", "Old team", "2026-09-01T00:00:00Z")]} personal={{ projects: [mine("p1", "My research", "2026-10-03T00:00:00Z"), mine("p2", "Notes", "2026-09-15T00:00:00Z")], ...handlers }}
      selected={null} expanded={new Set()} onToggle={vi.fn()} context={context} onOpen={vi.fn()} onPrivate={vi.fn()} {...over} />);
  it("shows personal and team projects as one list ordered by recent activity", () => {
    render_();
    expect(screen.getAllByRole("heading", { name: /projects/i })).toHaveLength(1);
    const list = screen.getByRole("navigation", { name: "Projects" });
    const names = within(list).getAllByRole("button", { name: /^Expand / }).map(button => button.getAttribute("aria-label"));
    expect(names).toEqual(["Expand My research", "Expand Team launch", "Expand Notes", "Expand Old team"]);
  });
  it("marks each row's kind for sighted and assistive users", () => {
    render_();
    const mineRow = screen.getByRole("button", { name: "Expand My research" });
    const teamRow = screen.getByRole("button", { name: "Expand Team launch" });
    expect(mineRow.parentElement!.querySelector("[data-project-kind=personal]")).toBeTruthy();
    expect(teamRow.parentElement!.querySelector("[data-project-kind=team]")).toBeTruthy();
    expect(mineRow.textContent).toContain("Personal project");
    expect(teamRow.textContent).toContain("Team project");
    expect(mineRow.getAttribute("title")).toContain("only you can see it");
  });
  it("keeps every row's kind icon in the same column, whatever actions the row offers", () => {
    render_({
      projects: [team("t1", "Team launch", "2026-10-02T00:00:00Z"), { ...team("t2", "Read only", "2026-09-01T00:00:00Z"), access: { actions: ["read"] } } as unknown as CloudProject],
      personal: { projects: [mine("p1", "Mine", "2026-10-03T00:00:00Z"), mine("p2", "Shelved", "2026-09-15T00:00:00Z", { status: "archived" })], ...handlers },
    });
    const headers = screen.getAllByRole("button", { name: /^Expand / }).map(button => button.parentElement!);
    expect(headers).toHaveLength(4);
    for (const header of headers) {
      const [title, kind, trailing, ...rest] = Array.from(header.children);
      expect(rest).toEqual([]);
      expect(title!.tagName).toBe("BUTTON");
      for (const slot of [kind as HTMLElement, trailing as HTMLElement]) {
        expect(slot.className).toContain("size-8");
        expect(slot.tagName === "BUTTON" || slot.getAttribute("aria-hidden") === "true").toBe(true);
      }
      expect((kind as HTMLElement).querySelector("[data-project-kind]")).toBeTruthy();
    }
  });
  it("uses a person for personal projects and people for team projects, never a lock", () => {
    render_();
    const mineKind = screen.getByRole("button", { name: "Expand My research" }).parentElement!.querySelector("[data-project-kind=personal]")!;
    const teamKind = screen.getByRole("button", { name: "Expand Team launch" }).parentElement!.querySelector("[data-project-kind=team]")!;
    expect(mineKind.getAttribute("class")).toContain("lucide-user");
    expect(mineKind.getAttribute("class")).not.toContain("lucide-lock");
    expect(teamKind.getAttribute("class")).toContain("lucide-users");
  });
  it("opens a personal project's instructions and files from the kind icon, which turns into a settings gear", async () => {
    const onSettings = vi.fn();
    render_({ personal: { projects: [mine("p1", "Mine", "2026-10-03T00:00:00Z")], ...handlers, onSettings, panelProjectId: "p1" } });
    const button = screen.getByRole("button", { name: "Instructions and files for Mine" });
    expect(button.parentElement).toBe(screen.getByRole("button", { name: "Expand Mine" }).parentElement);
    expect(button.getAttribute("aria-current")).toBe("page");
    expect(button.querySelector("[data-project-kind=personal]")).toBeTruthy();
    expect(button.querySelector(".lucide-settings")).toBeTruthy();
    expect(button.querySelector("[data-project-kind=personal]")!.getAttribute("class")).toContain("group-hover/kind:opacity-0");
    await userEvent.setup().click(button);
    expect(onSettings).toHaveBeenCalledWith("p1");
    await userEvent.setup().click(screen.getByRole("button", { name: "Expand Mine" }));
    expect(screen.queryByText("Instructions and files")).toBeNull();
  });
  it("keeps settings reachable on an archived personal project", () => {
    render_({ personal: { projects: [mine("p1", "Shelved", "2026-10-03T00:00:00Z", { status: "archived" })], ...handlers } });
    expect(screen.getByRole("button", { name: "Instructions and files for Shelved" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New conversation in Shelved/ })).toBeNull();
  });
  it("has a single creation control that opens the menu of permitted kinds", async () => {
    const onChoose = vi.fn();
    render_({ creation: { options: creationOptions({ available: true, canCreate: true }, personalCaps()), onChoose } });
    expect(screen.getAllByRole("button", { name: /^New (project|personal project|team project)$/ })).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(await screen.findByRole("menuitem", { name: /Personal project/ }));
    expect(onChoose).toHaveBeenCalledWith("personal");
  });
  it("works when only personal projects are available, and when only team projects are", () => {
    const { unmount } = render_({ projects: [] });
    expect(screen.getAllByRole("button", { name: /^Expand / })).toHaveLength(2);
    unmount();
    render_({ personal: undefined });
    expect(screen.getAllByRole("button", { name: /^Expand / })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Expand My research" })).toBeNull();
  });
  it("never lists a deleted personal project", () => {
    render_({ personal: { projects: [mine("p9", "Gone", "2026-10-09T00:00:00Z", { status: "deleted" })], ...handlers } });
    expect(screen.queryByRole("button", { name: "Expand Gone" })).toBeNull();
  });
  it("keeps personal chat opening and team scope switching separate", async () => {
    vi.mocked(cloudApi).mockImplementation(async (path: string) =>
      ({ conversations: [path.startsWith("/personal-projects") ? { id: "c-mine", title: "Private chat", revision: 1, createdAt: "", updatedAt: "2026-10-03T00:00:00Z" } : { id: "c-team", title: "Shared chat", revision: 1, createdAt: "", updatedAt: "2026-10-03T00:00:00Z", projectId: "t1" }], nextCursor: null }));
    const onOpen = vi.fn(), onPersonalOpen = vi.fn();
    render_({ onOpen, expanded: new Set(["t1"]), personal: { projects: [mine("p1", "My research", "2026-10-03T00:00:00Z")], ...handlers, onOpen: onPersonalOpen } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expand My research" }));
    await user.click(await screen.findByRole("button", { name: "Private chat" }));
    expect(onPersonalOpen).toHaveBeenCalledWith("p1", "c-mine");
    await user.click(await screen.findByRole("button", { name: "Shared chat" }));
    expect(onOpen).toHaveBeenCalledWith("t1", "c-team");
  });
  it("expands the project of the open chat once and opens a project when a chat is started in it", async () => {
    const onNew = vi.fn();
    render_({ personal: { projects: [mine("p1", "My research", "2026-10-03T00:00:00Z")], ...handlers, activeProjectId: "p1", onNew } });
    expect(await screen.findByRole("button", { name: "Collapse My research" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Collapse My research" }));
    await user.click(screen.getByRole("button", { name: "New conversation in My research" }));
    expect(onNew).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("button", { name: "Collapse My research" })).toBeTruthy();
  });
});
