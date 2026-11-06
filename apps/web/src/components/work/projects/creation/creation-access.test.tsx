import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { CreationAccess } from "./creation-access";

vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<typeof CloudApiModule>()), cloudApi: vi.fn() }));

const people = { members: [{ id: "m1", name: "Alice", email: "alice@example.test" }, { id: "m2", name: "Bob", email: "bob@example.test" }], teams: [{ id: "t1", name: "Analysts" }] };
const teamPolicy = { revision: 3, grants: [{ kind: "member" as const, subjectId: "m1" }] };
const personalPolicy = { revision: 4, allowAll: false, grants: [{ kind: "team" as const, subjectId: "t1" }], blockedMemberIds: [] as string[], maxPerMember: null as number | null, defaultMaxPerMember: 100 };

const route = (extra: (path: string, init?: RequestInit) => unknown = () => undefined) =>
  vi.mocked(cloudApi).mockImplementation(async (path: string, init?: RequestInit) => {
    const custom = extra(path, init);
    if (custom !== undefined) return custom as never;
    if (path === "/projects/capabilities") return { available: true } as never;
    if (path === "/personal-projects/directory") return people as never;
    if (path === "/projects/creation-policy" && !init?.method) return teamPolicy as never;
    if (path === "/personal-projects/policy" && !init?.method) return personalPolicy as never;
    throw new Error(`unexpected ${path}`);
  });
const body = (path: string) => JSON.parse(String(vi.mocked(cloudApi).mock.calls.find(([p, init]) => p === path && init?.method === "PUT")![1]?.body));
const card = (name: string) => within(screen.getByRole("region", { name }));
const choose = async (label: string, option: RegExp, scope: ReturnType<typeof within>) => {
  fireEvent.click(scope.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
};
const open = async (props: Partial<Parameters<typeof CreationAccess>[0]> = {}) => {
  render(<CreationAccess onSaved={vi.fn()} onDirtyChange={vi.fn()} onBusyChange={vi.fn()} {...props} />);
  await screen.findByRole("region", { name: "Team projects" });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 16, 320, 40));
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 768 });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document.documentElement, "clientWidth");
  Reflect.deleteProperty(document.documentElement, "clientHeight");
});

describe("Creation access", () => {
  it("shows team and personal creation as two separate cards that are saved independently", async () => {
    route();
    await open();
    expect(screen.getByRole("region", { name: "Personal projects" })).toBeTruthy();
    expect(await card("Team projects").findByText("Alice")).toBeTruthy();
    expect(card("Team projects").getByText("alice@example.test")).toBeTruthy();
    expect(await card("Personal projects").findByText("Analysts")).toBeTruthy();
    expect(card("Team projects").getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
    expect(card("Personal projects").getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  });

  it("adds a member to team creation and saves against the loaded revision", async () => {
    route((path, init) => (init?.method === "PUT" && path === "/projects/creation-policy" ? { revision: 4, grants: body(path).grants } : undefined));
    const onSaved = vi.fn(), onDirty = vi.fn();
    await open({ onSaved, onDirtyChange: onDirty });
    const team = card("Team projects");
    await team.findByText("Alice");
    await choose("Add a member or team for team projects", /Bob/, team);
    fireEvent.click(team.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(true));
    expect(team.getByText("Unsaved changes")).toBeTruthy();
    expect(card("Personal projects").getByText("No changes")).toBeTruthy();
    fireEvent.click(team.getByRole("button", { name: "Save changes" }));
    await team.findByText("Saved");
    expect(body("/projects/creation-policy")).toEqual({ expectedRevision: 3, grants: [{ kind: "member", subjectId: "m1" }, { kind: "member", subjectId: "m2" }] });
    expect(onSaved).toHaveBeenCalled();
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  });

  it("removes a team grant and can discard the change", async () => {
    route();
    await open();
    const team = card("Team projects");
    fireEvent.click(await team.findByRole("button", { name: "Remove Alice" }));
    expect(team.getByText(/No one has been given permission yet/)).toBeTruthy();
    fireEvent.click(team.getByRole("button", { name: "Discard" }));
    expect(team.getByText("Alice")).toBeTruthy();
  });

  it("saves the personal mode, grants, blocks and limit in one request", async () => {
    route((path, init) => (init?.method === "PUT" && path === "/personal-projects/policy" ? { ...personalPolicy, ...body(path), revision: 5, defaultMaxPerMember: 100 } : undefined));
    await open();
    const personal = card("Personal projects");
    expect(await personal.findByText("Analysts")).toBeTruthy();
    expect((personal.getByRole("radio", { name: /Only selected members and teams/ }) as HTMLInputElement).checked).toBe(true);
    await choose("Block a member", /Bob/, personal);
    fireEvent.click(personal.getByRole("button", { name: "Block" }));
    fireEvent.change(personal.getByRole("textbox", { name: "Projects kept per member" }), { target: { value: "5" } });
    fireEvent.click(personal.getByRole("radio", { name: /Everyone with Work access/ }));
    expect(personal.queryByRole("combobox", { name: "Add a member or team for personal projects" })).toBeNull();
    fireEvent.click(personal.getByRole("button", { name: "Save changes" }));
    await personal.findByText("Saved");
    expect(body("/personal-projects/policy")).toMatchObject({ expectedRevision: 4, allowAll: true, maxPerMember: 5, blockedMemberIds: ["m2"], grants: [{ kind: "team", subjectId: "t1" }] });
  });

  it("rejects an out-of-range limit before saving", async () => {
    route();
    await open();
    const personal = card("Personal projects");
    fireEvent.change(await personal.findByRole("textbox", { name: "Projects kept per member" }), { target: { value: "5000" } });
    expect(personal.getByText("Enter a whole number from 1 to 1000.")).toBeTruthy();
    expect(personal.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  });

  it("explains a member's effective permission and why", async () => {
    route((path) => (path.startsWith("/personal-projects/policy/effective") ? { memberId: "m1", allowed: false, source: "blocked" } : undefined));
    await open();
    const personal = card("Personal projects");
    await personal.findByText("Analysts");
    await choose("Member to check", /Alice/, personal);
    await personal.findByText("Alice cannot create personal projects.");
    expect(personal.getByText("Blocked for this member.")).toBeTruthy();
  });

  it("reports a revision conflict with a way to reload the latest policy", async () => {
    route((path, init) => {
      if (init?.method === "PUT" && path === "/personal-projects/policy") throw Object.assign(new Error("The creation policy changed. Reload it before trying again."), { status: 409 });
      return undefined;
    });
    await open();
    const personal = card("Personal projects");
    fireEvent.click(await personal.findByRole("radio", { name: /Everyone with Work access/ }));
    fireEvent.click(personal.getByRole("button", { name: "Save changes" }));
    await personal.findByRole("alert");
    fireEvent.click(personal.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect((personal.getByRole("radio", { name: /Everyone with Work access/ }) as HTMLInputElement).checked).toBe(false));
  });

  it("shows a readable error with a retry when the member list cannot be read", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ enabled: true });
    render(<CreationAccess onSaved={vi.fn()} onDirtyChange={vi.fn()} onBusyChange={vi.fn()} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });
});

it("saves personal creation access when team projects are unavailable", async () => {
  route((path, init) => {
    if (path === "/projects/capabilities") return { available: false };
    if (path === "/personal-projects/policy" && init?.method === "PUT") return { ...personalPolicy, ...body(path), revision: 5 };
    return undefined;
  });
  render(<CreationAccess onSaved={vi.fn()} onDirtyChange={vi.fn()} onBusyChange={vi.fn()} />);
  const personal = within(await screen.findByRole("region", { name: "Personal projects" }));
  fireEvent.click(await personal.findByRole("radio", { name: /Everyone with Work access/ }));
  fireEvent.click(personal.getByRole("button", { name: "Save changes" }));
  await personal.findByText("Saved");
  expect(body("/personal-projects/policy")).toMatchObject({ allowAll: true, expectedRevision: 4 });
  expect(screen.queryByRole("region", { name: "Team projects" })).toBeNull();
  expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path === "/projects/directory")).toBe(false);
});
