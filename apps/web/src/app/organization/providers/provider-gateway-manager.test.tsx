import type {
  OrganizationProviderGateway,
  OrganizationProviderGatewayCatalogResponse,
  OrganizationProviderGatewaysResponse,
} from "@lori-enterprise/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationProviderGatewayManager } from "@/app/organization/providers/provider-gateway-manager";

const catalog: OrganizationProviderGatewayCatalogResponse = {
  providers: [
    {
      defaultModel: "gpt-5",
      id: "openai",
      kind: "openai",
      name: "OpenAI",
    },
  ],
};

const gateway: OrganizationProviderGateway = {
  createdAt: "2026-07-31T00:00:00.000Z",
  credentialConfigured: true,
  enabledModels: ["gpt-5"],
  id: "5f9f3c8e-7b73-43d7-aaf3-2be61b482b4d",
  policyRevision: 6,
  providerId: "openai",
  providerKind: "openai",
  providerName: "OpenAI",
  requestsPerMinute: 60,
  updatedAt: "2026-07-31T00:00:00.000Z",
};

function renderManager(initialGateways: OrganizationProviderGatewaysResponse = { providerGateways: [] }) {
  render(
    <OrganizationProviderGatewayManager
      initialCatalog={catalog}
      initialGateways={initialGateways}
      initialRevision={5}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OrganizationProviderGatewayManager", () => {
  it("connects a provider without implicitly assigning it to members", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(gateway), {
        headers: { "content-type": "application/json" },
        status: 201,
      }),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    renderManager();
    await user.click(screen.getByRole("button", { name: /^Connect provider$/ }));
    await user.type(screen.getByLabelText("Provider API key"), "sk-company-key");
    await user.click(screen.getAllByRole("button", { name: /^Connect provider$/ }).at(-1)!);

    await screen.findByText("OpenAI is connected. Assign it in an access policy to make it available.");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/admin/provider-gateways");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      apiKey: "sk-company-key",
      enabledModels: ["gpt-5"],
      expectedRevision: 5,
      providerId: "openai",
      requestsPerMinute: 60,
    });
    expect(screen.getByRole("link", { name: "Manage assignments" })).toBeTruthy();
  });

  it("clears a typed upstream key when the connection dialog closes", async () => {
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByRole("button", { name: /^Connect provider$/ }));
    const key = screen.getByLabelText("Provider API key");
    await user.type(key, "sk-should-not-linger");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Connect provider$/ })).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /^Connect provider$/ }));
    expect(screen.getByLabelText("Provider API key")).toHaveProperty("value", "");
  });

  it("keeps the encrypted key intact when editing only models or rate protection", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ...gateway, policyRevision: 7 }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    renderManager({ providerGateways: [gateway] });
    await user.click(screen.getByRole("button", { name: "Edit OpenAI" }));
    await user.clear(screen.getByLabelText("Allowed models"));
    await user.type(screen.getByLabelText("Allowed models"), "gpt-5, gpt-5-mini");
    await user.click(screen.getByRole("button", { name: "Save provider" }));

    await screen.findByText("OpenAI provider settings saved.");
    const save = request.mock.calls.find(([url]) => url === `/api/v1/admin/provider-gateways/${gateway.id}`);
    expect(JSON.parse(String(save?.[1]?.body))).toEqual({
      enabledModels: ["gpt-5", "gpt-5-mini"],
      expectedRevision: 6,
      requestsPerMinute: 60,
    });
  });

  it("keeps the allowed list and the auto-fetched models in step", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ models: [{ id: "gpt-5-mini", name: "GPT-5 mini" }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ));
    const user = userEvent.setup();

    renderManager({ providerGateways: [gateway] });
    await user.click(screen.getByRole("button", { name: "Edit OpenAI" }));
    await user.click(await screen.findByRole("checkbox", { name: "Allow gpt-5-mini" }));
    expect(screen.getByLabelText("Allowed models")).toHaveProperty("value", "gpt-5, gpt-5-mini");

    await user.click(screen.getByRole("checkbox", { name: "Allow gpt-5" }));
    expect(screen.getByLabelText("Allowed models")).toHaveProperty("value", "gpt-5-mini");
  });

  it("gives a recoverable action when a concurrent policy change wins", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          error: "policy_revision_conflict",
          message: "Access settings changed while this page was open.",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 409,
        },
      ),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();

    renderManager();
    await user.click(screen.getByRole("button", { name: /^Connect provider$/ }));
    await user.type(screen.getByLabelText("Provider API key"), "sk-company-key");
    await user.click(screen.getAllByRole("button", { name: /^Connect provider$/ }).at(-1)!);

    expect(
      await screen.findByRole("button", { name: "Reload latest" }),
    ).toBeTruthy();
  });
});
