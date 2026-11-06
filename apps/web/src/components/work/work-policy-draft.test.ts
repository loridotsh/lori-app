import { describe, expect, it } from "vitest";
import {
  draftOf,
  rebaseWorkDraft,
  validateWorkDraft,
} from "./work-policy-draft";
import type { EnterpriseWorkPolicy } from "@lori-enterprise/contracts";
const policy: EnterpriseWorkPolicy = {
  schemaVersion: 1,
  revision: 1,
  enabled: true,
  forceAskMe: false,
  memoryAllowed: true,
  personalInstallations: { plugins: true, providers: true, skills: true },
  managedCatalog: [{ id: "notion", type: "plugin", enabled: true }],
  providerModels: [{ providerId: "openai", modelIds: ["original"] }],
};
describe("Work policy conflict recovery", () => {
  it("reapplies an access edit without resurrecting a provider removed by another admin", () => {
    const before = draftOf(policy);
    const local = { ...before, enabled: false };
    const latest = {
      ...before,
      providerModels: [],
      managedCatalog: [
        ...before.managedCatalog,
        { id: "research", type: "skill" as const, enabled: true },
      ],
    };
    expect(rebaseWorkDraft(before, local, latest)).toEqual({
      ...latest,
      enabled: false,
    });
  });
  it("keeps a concurrently added model while applying a local model removal", () => {
    const before = draftOf(policy);
    const local = {
      ...before,
      providerModels: [{ providerId: "openai", modelIds: [] }],
    };
    const latest = {
      ...before,
      providerModels: [
        { providerId: "openai", modelIds: ["original", "added-by-teammate"] },
      ],
    };
    expect(rebaseWorkDraft(before, local, latest).providerModels).toEqual([
      { providerId: "openai", modelIds: ["added-by-teammate"] },
    ]);
  });
  it("validates actual server limits and permits single-line provider model names", () => {
    const draft = draftOf(policy);
    expect(
      validateWorkDraft({
        ...draft,
        providerModels: [
          {
            providerId: "openai",
            modelIds: Array.from({ length: 33 }, (_, i) => `model-${i}`),
          },
        ],
      }),
    ).toMatch(/32/);
    expect(
      validateWorkDraft({
        ...draft,
        providerModels: [{ providerId: "openai", modelIds: ["model\nunsafe"] }],
      }),
    ).toMatch(/control characters/);
    expect(
      validateWorkDraft({
        ...draft,
        providerModels: [{ providerId: "openai", modelIds: ["model family"] }],
      }),
    ).toBeNull();
  });
});
