import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectPolicy } from "@lori-enterprise/contracts";
import { workApi } from "@/lib/work-api";
import { ProjectPolicyControls } from "./project-policy-controls";
vi.mock("@/lib/work-api", () => ({ workApi: vi.fn() }));
afterEach(cleanup);
const base: ProjectPolicy = { memoryEnabled: true, forceAskMe: true, exportsAllowed: true, externalWritesAllowed: false, managersManageMembers: false, managersManageConnections: false, providerModels: [], pluginIds: [] };
beforeEach(() => {
  vi.mocked(workApi).mockImplementation(async path => path.endsWith("provider-gateways")
    ? { providerGateways: [{ providerId: "openai", providerName: "OpenAI", credentialConfigured: true }], revision: 1 }
    : path.endsWith("catalog")
      ? { items: [{ id: "notion", type: "plugin", name: "Notion", description: "", featured: false, requiresAuth: true }, { id: "linear", type: "plugin", name: "Linear", description: "", featured: false, requiresAuth: true }] }
      : { revision: 1, enabled: false, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [], providerModels: [], effective: { enabled: true, personalInstallations: { plugins: false, providers: false, skills: false }, managedCatalog: [{ type: "provider", id: "openai" }, { type: "plugin", id: "notion" }], providerModels: [{ providerId: "openai", modelIds: ["model-a"] }] } });
});
it("offers organization-approved models once the project assigns its own resources", async () => {
  const onChange = vi.fn();
  const { rerender } = render(<ProjectPolicyControls policy={base} onChange={onChange} disabled={false} />);
  // An inheriting project shows no model list: members use their Work access.
  fireEvent.click(await screen.findByLabelText(/Assign models to this project/));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ providerMode: "assigned" }));
  rerender(<ProjectPolicyControls policy={{ ...base, providerMode: "assigned" }} onChange={onChange} disabled={false} />);
  fireEvent.click(await screen.findByLabelText("OpenAI · model-a"));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ providerMode: "assigned", providerModels: [{ providerId: "openai", modelIds: ["model-a"] }] }));
});
it("treats a legacy nonempty selection as an assignment and keeps unapproved items removable only", async () => {
  render(<ProjectPolicyControls policy={{ ...base, pluginIds: ["linear"] }} onChange={vi.fn()} disabled={false} />);
  expect(((await screen.findByLabelText(/Assign plugins to this project/)) as HTMLInputElement).checked).toBe(true);
  const unapproved = await screen.findByLabelText(/Linear/) as HTMLInputElement;
  expect(unapproved.checked).toBe(true);
  expect(unapproved.disabled).toBe(false);
  expect(screen.getByText(/not approved, unavailable/)).toBeTruthy();
  expect((screen.getByLabelText(/Notion/) as HTMLInputElement).disabled).toBe(false);
});
