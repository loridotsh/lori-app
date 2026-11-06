import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnterpriseWorkPolicy,
  PolicyCatalog,
} from "@lori-enterprise/contracts";
import { WorkPolicyEditor, type WorkMemberView } from "./work-policy-editor";
import { clientApi, ClientApiError } from "@/lib/client-api";
vi.mock("@/lib/client-api", async () => ({
  ...(await vi.importActual("@/lib/client-api")),
  clientApi: vi.fn(),
}));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: vi.fn() }));
const policy: EnterpriseWorkPolicy = {
  schemaVersion: 1,
  revision: 7,
  enabled: true,
  forceAskMe: false,
  memoryAllowed: true,
  personalInstallations: { plugins: true, providers: true, skills: true },
  managedCatalog: [{ id: "notion", type: "plugin", enabled: true }],
  providerModels: [{ providerId: "openai", modelIds: ["model-a"] }],
};
const catalog: PolicyCatalog = {
  items: [
    {
      id: "openai",
      name: "OpenAI",
      description: "Company models",
      type: "provider",
      featured: true,
      requiresAuth: true,
    },
  ],
  connectedOrganizationProviderIds: ["openai"],
};
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
describe("Work policy editor", () => {
  it("saves access without dropping independent Work assignments", async () => {
    vi.mocked(clientApi).mockResolvedValue({
      ...policy,
      enabled: false,
      revision: 8,
    });
    render(
      <WorkPolicyEditor
        initialPolicy={policy}
        catalog={catalog}
        mode="organization"
        endpoint="/v1/admin/work/policy"
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Allow Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(clientApi).toHaveBeenCalledTimes(1));
    const [path, options] = vi.mocked(clientApi).mock.calls[0]!;
    expect(path).toBe("/v1/admin/work/policy");
    const body = JSON.parse(options!.body as string);
    expect(body.expectedRevision).toBe(7);
    expect(body.policy).toMatchObject({
      enabled: false,
      managedCatalog: policy.managedCatalog,
      providerModels: policy.providerModels,
    });
    await screen.findByText(/Work access saved/);
  });
  it("keeps member inherited decisions nullable and cannot edit organization safeguards", async () => {
    const member: WorkMemberView = {
      effective: policy,
      inherited: policy,
      organization: policy,
      overrides: {
        enabled: null,
        personalInstallations: { providers: null, plugins: null, skills: null },
        managedCatalog: [],
        providerModels: [],
      },
    };
    vi.mocked(clientApi).mockResolvedValue({
      ...member,
      organization: { ...policy, revision: 8 },
    });
    render(
      <WorkPolicyEditor
        initialPolicy={policy}
        initialMember={member}
        catalog={catalog}
        mode="member"
        endpoint="/v1/admin/work/members/member-id/policy"
      />,
    );
    expect(
      screen.queryByRole("switch", { name: "Require action approvals" }),
    ).toBeNull();
    expect(
      screen.getByLabelText("Require action approvals: Member preference"),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Allow Work" }), {
      target: { value: "deny" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(clientApi).toHaveBeenCalledOnce());
    expect(
      JSON.parse(vi.mocked(clientApi).mock.calls[0]![1]!.body as string)
        .overrides,
    ).toEqual({ ...member.overrides, enabled: false });
  });
  it("never offers a save action for a member viewing their own access", () => {
    render(
      <WorkPolicyEditor
        initialPolicy={policy}
        catalog={catalog}
        mode="viewer"
        endpoint="/v1/work/policy"
      />,
    );
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Allow Work" })).toBeNull();
    expect(screen.getByLabelText("Allow Work: Allowed")).toBeTruthy();
  });
  it("blocks repeated saving after a revision conflict", async () => {
    vi.mocked(clientApi).mockRejectedValue(
      new ClientApiError("policy_revision_conflict", "Stale policy", 409),
    );
    render(
      <WorkPolicyEditor
        initialPolicy={policy}
        catalog={catalog}
        mode="organization"
        endpoint="/v1/admin/work/policy"
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Allow Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Review latest policy" });
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("edits Work model IDs independently of catalog assignment", async () => {
    vi.mocked(clientApi).mockResolvedValue({ ...policy, revision: 8 });
    render(
      <WorkPolicyEditor
        initialPolicy={policy}
        catalog={catalog}
        mode="organization"
        endpoint="/v1/admin/work/policy"
        section="providers"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "OpenAI model ID" }), {
      target: { value: "model-b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(clientApi).toHaveBeenCalledOnce());
    const sent = JSON.parse(
      vi.mocked(clientApi).mock.calls[0]![1]!.body as string,
    );
    expect(sent.policy.providerModels).toEqual([
      { providerId: "openai", modelIds: ["model-a", "model-b"] },
    ]);
    expect(sent.policy.managedCatalog).toEqual(policy.managedCatalog);
  });
});

it("reviews a conflicting revision without discarding the draft or other admin assignments", async () => {
  const latest = {
    ...policy,
    revision: 8,
    managedCatalog: [
      ...policy.managedCatalog,
      { id: "research", type: "skill" as const, enabled: true },
    ],
  };
  vi.mocked(clientApi)
    .mockRejectedValueOnce(
      new ClientApiError("policy_revision_conflict", "Stale", 409),
    )
    .mockResolvedValueOnce(latest)
    .mockResolvedValueOnce({ ...latest, enabled: false, revision: 9 });
  render(
    <WorkPolicyEditor
      initialPolicy={policy}
      catalog={catalog}
      mode="organization"
      endpoint="/v1/admin/work/policy"
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Allow Work" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Review latest policy" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Apply my edits to latest" }),
  );
  expect(
    (
      screen.getByRole("switch", { name: "Allow Work" }) as HTMLButtonElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(clientApi).toHaveBeenCalledTimes(3));
  const body = JSON.parse(
    vi.mocked(clientApi).mock.calls[2]![1]!.body as string,
  );
  expect(body.expectedRevision).toBe(8);
  expect(body.policy.enabled).toBe(false);
  expect(body.policy.managedCatalog).toEqual(latest.managedCatalog);
});

it.each([401, 403])(
  "keeps edits and offers access recovery for %i",
  async (status) => {
    vi.mocked(clientApi).mockRejectedValueOnce(
      new ClientApiError("access_failed", "Private diagnostic", status),
    );
    render(
      <WorkPolicyEditor
        initialPolicy={policy}
        catalog={catalog}
        mode="organization"
        endpoint="/v1/admin/work/policy"
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Allow Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Refresh access" });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.queryByText("Private diagnostic")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("switch", { name: "Allow Work" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    if (status === 401)
      expect(
        screen
          .getByRole("link", { name: "Sign in again" })
          .getAttribute("target"),
      ).toBe("_blank");
  },
);

it("preserves the draft and blocks immediate retry after rate limiting", async () => {
  vi.mocked(clientApi).mockRejectedValueOnce(
    new ClientApiError("rate_limited", "Wait", 429, undefined, 30),
  );
  render(
    <WorkPolicyEditor
      initialPolicy={policy}
      catalog={catalog}
      mode="organization"
      endpoint="/v1/admin/work/policy"
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Allow Work" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/Try again in 30 seconds/);
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(clientApi).toHaveBeenCalledTimes(1);
});

it("separates plugins and skills and gives filtered lists a recovery action", () => {
  const extensions: PolicyCatalog = {
    ...catalog,
    items: [
      ...catalog.items,
      {
        id: "notion",
        type: "plugin",
        name: "Notion",
        description: "Search your notes",
        featured: true,
        requiresAuth: true,
      },
      {
        id: "research",
        type: "skill",
        name: "Research",
        description: "Grounded research guidance",
        featured: true,
        requiresAuth: false,
      },
    ],
  };
  render(
    <WorkPolicyEditor
      initialPolicy={policy}
      catalog={extensions}
      mode="organization"
      endpoint="/v1/admin/work/policy"
      section="extensions"
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "Notion assignment" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("combobox", { name: "Research assignment" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
  expect(
    screen.getByRole("combobox", { name: "Research assignment" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Show extensions" }), {
    target: { value: "assigned" },
  });
  expect(screen.getByText("No extensions match these filters")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(
    screen.getByRole("combobox", { name: "Research assignment" }),
  ).toBeTruthy();
});

it("keeps member edits when a malformed successful response cannot be verified", async () => {
  const member: WorkMemberView = {
    effective: policy,
    inherited: policy,
    organization: policy,
    overrides: {
      enabled: null,
      personalInstallations: { providers: null, plugins: null, skills: null },
      managedCatalog: [],
      providerModels: [],
    },
  };
  vi.mocked(clientApi).mockResolvedValueOnce({
    ...member,
    effective: null,
    overrides: null,
  });
  render(
    <WorkPolicyEditor
      initialPolicy={policy}
      initialMember={member}
      catalog={catalog}
      mode="member"
      endpoint="/v1/admin/work/members/member-id/policy"
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Allow Work" }), {
    target: { value: "deny" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("button", { name: "Review latest policy" });
  expect(
    (screen.getByRole("combobox", { name: "Allow Work" }) as HTMLSelectElement)
      .value,
  ).toBe("deny");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
});

it("retains an explicit empty model assignment after removing the last model", async () => {
  vi.mocked(clientApi).mockResolvedValueOnce({
    ...policy,
    revision: 8,
    providerModels: [{ providerId: "openai", modelIds: [] }],
  });
  render(
    <WorkPolicyEditor
      initialPolicy={policy}
      catalog={catalog}
      mode="organization"
      endpoint="/v1/admin/work/policy"
      section="providers"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove model-a" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(clientApi).toHaveBeenCalledTimes(1));
  expect(
    JSON.parse(vi.mocked(clientApi).mock.calls[0]![1]!.body as string).policy
      .providerModels,
  ).toEqual([{ providerId: "openai", modelIds: [] }]);
});

it("clarifies that saved allowed settings are inactive when the member's Work access is disabled", () => {
  render(
    <WorkPolicyEditor
      initialPolicy={{ ...policy, enabled: false }}
      catalog={catalog}
      mode="viewer"
      endpoint="/v1/work/policy"
    />,
  );
  expect(
    screen.getByText(
      "Work is disabled. Saved settings below apply only when access is restored.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("What you can add")).toBeTruthy();
  expect(screen.queryByRole("switch")).toBeNull();
});

it("preserves explicit resource blocks and lets administrators choose member defaults deliberately", async () => {
  const extensions: PolicyCatalog = {
    ...catalog,
    items: [
      {
        id: "notion",
        type: "plugin",
        name: "Notion",
        description: "Notes",
        featured: true,
        requiresAuth: true,
      },
    ],
  };
  const blocked = {
    ...policy,
    managedCatalog: [{ id: "notion", type: "plugin" as const, enabled: false }],
  };
  vi.mocked(clientApi).mockResolvedValueOnce({
    ...blocked,
    revision: 8,
    managedCatalog: [],
  });
  render(
    <WorkPolicyEditor
      initialPolicy={blocked}
      catalog={extensions}
      mode="organization"
      endpoint="/v1/admin/work/policy"
      section="extensions"
    />,
  );
  expect(
    (
      screen.getByRole("combobox", {
        name: "Notion assignment",
      }) as HTMLSelectElement
    ).value,
  ).toBe("deny");
  fireEvent.change(
    screen.getByRole("combobox", { name: "Notion assignment" }),
    { target: { value: "inherit" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(clientApi).toHaveBeenCalledTimes(1));
  expect(
    JSON.parse(vi.mocked(clientApi).mock.calls[0]![1]!.body as string).policy
      .managedCatalog,
  ).toEqual([]);
});

it("removes a team assignment without creating an item-level block", async () => {
  const extensions: PolicyCatalog = {
    ...catalog,
    items: [
      {
        id: "notion",
        type: "plugin",
        name: "Notion",
        description: "Notes",
        featured: true,
        requiresAuth: true,
      },
    ],
  };
  vi.mocked(clientApi).mockResolvedValueOnce({
    ...policy,
    revision: 8,
    managedCatalog: [],
  });
  render(
    <WorkPolicyEditor
      initialPolicy={policy}
      catalog={extensions}
      mode="team"
      endpoint="/v1/teams/team-id/work/policy"
      section="extensions"
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Assign Notion" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(clientApi).toHaveBeenCalledTimes(1));
  expect(
    JSON.parse(vi.mocked(clientApi).mock.calls[0]![1]!.body as string).policy
      .managedCatalog,
  ).toEqual([]);
});
