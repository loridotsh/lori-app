import type {
  EnterpriseWorkPolicy,
  PolicyCatalog,
} from "@lori-enterprise/contracts";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkProviderAssignments,
  type WorkProviderAssignmentsProps,
} from "./work-provider-assignments";
import { workApi } from "@/lib/work-api";

vi.mock("@/lib/work-api", () => ({ workApi: vi.fn() }));
const policy: EnterpriseWorkPolicy = {
  schemaVersion: 1,
  revision: 7,
  enabled: true,
  forceAskMe: false,
  memoryAllowed: true,
  personalInstallations: { providers: true, plugins: true, skills: true },
  managedCatalog: [{ id: "openai", type: "provider", enabled: true }],
  providerModels: [{ providerId: "openai", modelIds: ["model-a"] }],
};
const catalog: PolicyCatalog = {
  connectedOrganizationProviderIds: ["openai"],
  items: ["openai", "anthropic"].map((id) => ({
    id,
    name: id === "openai" ? "OpenAI" : "Anthropic",
    type: "provider",
    description: "Company models",
    featured: true,
    requiresAuth: true,
  })),
};
const gateway = {
  id: "gateway-1",
  providerId: "openai",
  providerName: "OpenAI",
  credentialConfigured: true as const,
  requestsPerMinute: 60,
  policyRevision: 7,
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
};
function setup(overrides: Partial<WorkProviderAssignmentsProps> = {}) {
  const props: WorkProviderAssignmentsProps = {
    catalog,
    mode: "organization",
    readOnly: false,
    disabled: false,
    effective: policy,
    inherited: policy,
    managedCatalog: policy.managedCatalog,
    providerModels: policy.providerModels,
    onCatalog: vi.fn(),
    onModel: vi.fn(),
    onReviewLatest: vi.fn(),
    ...overrides,
  };
  return { ...render(<WorkProviderAssignments {...props} />), props };
}
beforeEach(() => { vi.mocked(workApi).mockReset(); });
describe("Work provider assignments", () => {
  it("keeps model inputs hidden until Configure and adds exact printable model IDs", () => {
    const { props } = setup();
    expect(
      screen.queryByRole("textbox", { name: "OpenAI model ID" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "OpenAI model ID" }), {
      target: { value: "model+fast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(props.onModel).toHaveBeenCalledWith("openai", "model+fast", true);
    expect(props.onCatalog).not.toHaveBeenCalled();
  });
  it("searches provider names and model IDs and handles empty results", () => {
    setup();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search Work providers" }),
      { target: { value: "model-a" } },
    );
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.queryByText("Anthropic")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search Work providers" }),
      { target: { value: "unknown" } },
    );
    expect(screen.getByText("No providers match your search")).toBeTruthy();
  });
  it("shows a member only available resources and desktop personal-key guidance", () => {
    setup({ mode: "viewer", readOnly: true });
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Configure/ })).toBeNull();
    expect(screen.getByText(/Work → LLM Providers/)).toBeTruthy();
    expect(workApi).not.toHaveBeenCalled();
  });
  it("assigns a connected provider when a model is chosen for it", async () => {
    vi.mocked(workApi).mockImplementation(async (path: string) =>
      path.endsWith("/models")
        ? ({ models: [{ id: "model-b", name: "model-b" }] } as never)
        : ({ providerGateways: [gateway], revision: 7 } as never),
    );
    const { props } = setup({
      canManageConnections: true,
      managedCatalog: [],
      providerModels: [],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Configure OpenAI" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Allow model-b" }));
    expect(props.onModel).toHaveBeenCalledWith("openai", "model-b", true);
    expect(props.onCatalog).toHaveBeenCalledWith("openai", "provider", true);
  });
  it("warns when a connected key with models is left unshared", async () => {
    vi.mocked(workApi).mockResolvedValue({ providerGateways: [gateway], revision: 7 } as never);
    setup({ canManageConnections: true, managedCatalog: [] });
    expect(await screen.findByText(/not shared yet/)).toBeTruthy();
  });
  it("gives an individual a plain switch and no company wording", async () => {
    vi.mocked(workApi).mockResolvedValue({ providerGateways: [gateway], revision: 7 } as never);
    const { props } = setup({ canManageConnections: true, personalWorkspace: true, managedCatalog: [] });
    const toggle = await screen.findByRole("switch", { name: "Use OpenAI in Work" });
    expect(screen.queryByRole("combobox", { name: "OpenAI assignment" })).toBeNull();
    fireEvent.click(toggle);
    expect(props.onCatalog).toHaveBeenCalledWith("openai", "provider", true);
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    expect(screen.queryByText(/company/i)).toBeNull();
  });
  it("preserves nullable inherited overrides and keeps team key administration hidden", () => {
    const { props } = setup({
      mode: "team-member",
      managedCatalog: [],
      modelOverrides: [],
      canManageConnections: true,
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "OpenAI assignment" }),
      { target: { value: "deny" } },
    );
    expect(props.onCatalog).toHaveBeenCalledWith("openai", "provider", false);
    fireEvent.change(
      screen.getByRole("combobox", { name: "OpenAI assignment" }),
      { target: { value: "inherit" } },
    );
    expect(props.onCatalog).toHaveBeenLastCalledWith(
      "openai",
      "provider",
      null,
    );
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    expect(screen.queryByRole("button", { name: /company key/i })).toBeNull();
    expect(workApi).not.toHaveBeenCalled();
  });
  it("never automatically grants access when saving a company key", async () => {
    vi.mocked(workApi)
      .mockResolvedValueOnce({ providerGateways: [gateway], revision: 7 })
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ pricing: {}, revision: 7 })
      .mockResolvedValueOnce({ ...gateway, policyRevision: 8 });
    const changed = vi.fn();
    const { props } = setup({
      canManageConnections: true,
      onConnectionsChanged: changed,
    });
    await waitFor(() =>
      expect(screen.queryByText(/Checking company/)).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: "Update company key" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New API key"), {
      target: { value: "private-key-example" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Replace company key" }),
    );
    await waitFor(() => expect(changed).toHaveBeenCalledWith(8));
    expect(props.onCatalog).not.toHaveBeenCalled();
    expect(props.onModel).not.toHaveBeenCalled();
    const [path, request] = vi.mocked(workApi).mock.calls.find(([, request]) => request?.method === "PATCH")!;
    expect(path).toBe("/v1/admin/work/provider-gateways/gateway-1");
    expect(JSON.parse(request!.body as string)).toEqual({
      apiKey: "private-key-example",
      expectedRevision: 7,
    });
    expect(document.body.textContent).not.toContain("private-key-example");
    expect(screen.getByText(/availability has not been verified/)).toBeTruthy();
  });
  it("handles malformed connection metadata without offering a duplicate connection write", async () => {
    vi.mocked(workApi).mockResolvedValueOnce({ unexpected: true });
    setup({ canManageConnections: true });
    await screen.findByRole("button", { name: "Retry connection status" });
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Update company key",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("does not accept a late connection response after organization controls are removed", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(workApi).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = setup({ canManageConnections: true });
    view.rerender(<WorkProviderAssignments {...view.props} mode="team" />);
    resolve({ providerGateways: [gateway], revision: 7 });
    await waitFor(() =>
      expect(screen.queryByText(/Checking company/)).toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("requires an explicit model correction instead of silently ignoring an invalid or duplicate ID", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    fireEvent.change(screen.getByRole("textbox", { name: "OpenAI model ID" }), {
      target: { value: "model-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    expect(screen.getByRole("alert").textContent).toContain("already allowed");
    expect(props.onModel).not.toHaveBeenCalled();
  });
});

it("does not offer active personal-provider setup while Work is disabled", () => {
  setup({
    mode: "viewer",
    readOnly: true,
    effective: { ...policy, enabled: false },
  });
  expect(
    screen.getByText(/Saved provider assignments become available/),
  ).toBeTruthy();
  expect(screen.queryByText(/Work → LLM Providers/)).toBeNull();
});

it("distinguishes organization member choice from an explicit provider block", () => {
  const view = setup({ managedCatalog: [] });
  const select = screen.getByRole("combobox", {
    name: "OpenAI assignment",
  }) as HTMLSelectElement;
  expect(select.value).toBe("inherit");
  fireEvent.change(select, { target: { value: "deny" } });
  expect(view.props.onCatalog).toHaveBeenCalledWith(
    "openai",
    "provider",
    false,
  );
  fireEvent.change(select, { target: { value: "inherit" } });
  expect(view.props.onCatalog).toHaveBeenLastCalledWith(
    "openai",
    "provider",
    null,
  );
  expect(view.props.onModel).not.toHaveBeenCalled();
});
it("removes a team provider grant without creating a member-wide block", () => {
  const { props } = setup({ mode: "team" });
  fireEvent.click(screen.getByRole("switch", { name: "Assign OpenAI" }));
  expect(props.onCatalog).toHaveBeenCalledWith("openai", "provider", null);
});

it("rejects connection metadata older than the current policy revision", async () => {
  vi.mocked(workApi).mockResolvedValueOnce({
    providerGateways: [gateway],
    revision: 6,
  });
  setup({ canManageConnections: true });
  await screen.findByRole("button", { name: "Retry connection status" });
  expect(screen.getAllByText("Status unavailable").length).toBe(2);
  expect(screen.queryByText("Key configured")).toBeNull();
});

describe("automatic models", () => {
  const synced = { ...gateway, modelSync: { enabled: true, modelIds: Array.from({ length: 96 }, (_, index) => `m${index}`) } };
  const mockApi = (connection: typeof synced) =>
    vi.mocked(workApi).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") return { ...connection, policyRevision: 8 };
      if (path === "/v1/admin/work/provider-gateways") return { providerGateways: [connection], revision: 7 };
      return path.endsWith("/models") ? { models: [] } : { pricing: {}, revision: 7 };
    });

  it("reports all models instead of a hand-picked list", async () => {
    mockApi(synced);
    setup({ canManageConnections: true });
    expect(await screen.findByText("All 96 models enabled")).toBeTruthy();
  });
  it("turns automatic models off through the connection, never the saved policy", async () => {
    mockApi(synced);
    const changed = vi.fn();
    const { props } = setup({ canManageConnections: true, onConnectionsChanged: changed });
    await screen.findByText("All 96 models enabled");
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose models" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(8));
    const [, request] = vi.mocked(workApi).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(request!.body as string)).toEqual({ autoModels: false, expectedRevision: 7 });
    expect(props.onModel).not.toHaveBeenCalled();
    expect(props.onCatalog).not.toHaveBeenCalled();
  });
  it("offers no switch for a provider whose listing cannot be trusted to enable models", async () => {
    mockApi(gateway as typeof synced);
    setup({ canManageConnections: true });
    await waitFor(() => expect(screen.queryByText(/Checking company/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI" }));
    expect(screen.queryByRole("button", { name: "All models" })).toBeNull();
  });
  it("connects an unconnected provider directly and opens it afterwards", async () => {
    const created = { ...gateway, id: "gateway-2", providerId: "anthropic", providerName: "Anthropic" };
    vi.mocked(workApi).mockImplementation(async (path, init) => {
      if (init?.method === "POST") return created;
      if (path === "/v1/admin/work/provider-gateways") return { providerGateways: [gateway], revision: 7 };
      return path.endsWith("/models") ? { models: [] } : { pricing: {}, revision: 7 };
    });
    setup({ canManageConnections: true });
    fireEvent.click(await screen.findByRole("button", { name: "Connect Anthropic" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connected" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Available" })).toBeTruthy();
  });
});
