import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PeopleResponse, Viewer } from "@lori-enterprise/contracts";
import { organizationCapabilities } from "@lori-enterprise/contracts";
import type * as ClientApiModule from "@/lib/client-api";
import { ClientApiError, clientApi } from "@/lib/client-api";
import { PeopleManager } from "./people-manager";

vi.mock("@/lib/client-api", async (original) => ({
  ...(await original<typeof ClientApiModule>()),
  clientApi: vi.fn(),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));

const people: PeopleResponse = {
  revision: 7,
  members: [
    { memberId: "m-owner", userId: "u-owner", name: "Olivia Owner", email: "owner@example.test", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
    { memberId: "m-admin", userId: "u-admin", name: "Adam Admin", email: "admin@example.test", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" },
    { memberId: "m-member", userId: "u-member", name: "Mia Member", email: "member@example.test", role: "member", createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  invitations: [
    { id: "i-admin", email: "new-admin@example.test", role: "admin", state: "pending", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", invitedByName: "Olivia Owner" },
  ],
};
const viewerFor = (role: Viewer["role"], userId: string): Viewer => ({
  organization: { id: "org", name: "Acme" },
  role,
  authority: { role, capabilities: organizationCapabilities(role), revision: 7, ownerAssigned: true },
  user: { id: userId, name: "Viewer", email: `${userId}@example.test` },
});

beforeEach(() => {
  vi.mocked(clientApi).mockResolvedValue(people);
});
afterEach(() => {
  cleanup();
  vi.mocked(clientApi).mockReset();
  refresh.mockReset();
});

it("keeps administrator appointments and ownership out of an admin's controls", () => {
  render(<PeopleManager initialPeople={people} viewer={viewerFor("admin", "u-admin")} />);
  expect(screen.queryByRole("button", { name: "Transfer ownership" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Role for Olivia Owner" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Role for Adam Admin" })).toBeNull();
  // An admin cannot promote a member to admin, so there is nothing to choose for them either.
  expect(screen.queryByRole("combobox", { name: "Role for Mia Member" })).toBeNull();
  expect((screen.getByRole("button", { name: "Remove Olivia Owner" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Remove Mia Member" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText(/Only the owner can manage admin invitations/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Invite member" })[0]!);
  const role = screen.getByRole("combobox", { name: "Role" }) as HTMLSelectElement;
  expect(role.disabled).toBe(true);
  expect([...role.options].map((option) => option.value)).toEqual(["member"]);
  expect(screen.getByText(/Only the organization owner can invite admins/)).toBeTruthy();
});

it("shows the role's authority before an owner saves a role change, with the reviewed revision", async () => {
  render(<PeopleManager initialPeople={people} viewer={viewerFor("owner", "u-owner")} />);
  expect(screen.queryByRole("combobox", { name: "Role for Olivia Owner" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Role for Mia Member" }), { target: { value: "admin" } });
  expect(await screen.findByText(/Manages members, teams, policies/)).toBeTruthy();
  expect(vi.mocked(clientApi).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Make admin" }));
  await waitFor(() => expect(vi.mocked(clientApi).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  const call = vi.mocked(clientApi).mock.calls.find(([, init]) => init?.method === "PATCH")!;
  expect(call[0]).toBe("/v1/admin/members/m-member");
  expect(JSON.parse(String(call[1]?.body))).toEqual({ role: "admin", expectedRevision: 7 });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it("transfers ownership only after typed confirmation and explains a stale sign-in", async () => {
  vi.mocked(clientApi).mockImplementation(async (path) => {
    if (path === "/v1/admin/ownership-transfer")
      throw new ClientApiError("session_not_fresh", "Sign in again to transfer ownership.", 403);
    return people;
  });
  render(<PeopleManager initialPeople={people} viewer={viewerFor("owner", "u-owner")} />);
  fireEvent.click(screen.getByRole("button", { name: "Transfer ownership" }));
  fireEvent.change(screen.getByRole("combobox", { name: "New owner" }), { target: { value: "m-admin" } });
  const dialog = screen.getByRole("combobox", { name: "New owner" }).closest("dialog")!;
  const confirm = within(dialog).getByRole("button", { name: "Transfer ownership" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Type admin@example.test to confirm/), { target: { value: "admin@example.test" } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  expect(await screen.findByRole("button", { name: "Sign in again" })).toBeTruthy();
  const call = vi.mocked(clientApi).mock.calls.find(([path]) => path === "/v1/admin/ownership-transfer")!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({ expectedRevision: 7, memberId: "m-admin" });
});

it("removes a member against the reviewed revision and starts over when roles changed elsewhere", async () => {
  vi.mocked(clientApi).mockImplementation(async (path, init) => {
    if (init?.method === "DELETE")
      throw new ClientApiError("access_revision_conflict", "Organization access changed.", 409);
    return people;
  });
  render(<PeopleManager initialPeople={people} viewer={viewerFor("owner", "u-owner")} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mia Member" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove member" }));
  await waitFor(() => expect(screen.getAllByText(/Roles changed while you were reviewing them/).length).toBeGreaterThan(0));
  const call = vi.mocked(clientApi).mock.calls.find(([, init]) => init?.method === "DELETE")!;
  expect(call[0]).toBe("/v1/admin/members/m-member?expectedRevision=7");
  // The dialog closes and the latest list is loaded before anything is retried.
  expect(screen.queryByRole("button", { name: "Remove member" })).toBeNull();
  expect(vi.mocked(clientApi).mock.calls.some(([path]) => path === "/v1/admin/people")).toBe(true);
});
