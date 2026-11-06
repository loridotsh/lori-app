import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerProjectRoutes } from "./routes.js";
import type { CloudWorkService } from "../service.js";
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it("binds the desktop directory request to its validated project and authenticated actor", async () => {
  const app = Fastify();
  const actor = { organizationId: "org", memberId: "member", deviceId: "device" };
  const directory = vi.fn().mockResolvedValue({ members: [], teams: [] });
  registerProjectRoutes(app, { actor: async () => actor, config: { cloud: { desktopProjectsEnabled: true } }, projects: { directory } } as unknown as CloudWorkService);
  try {
    const response = await app.inject({ method: "GET", url: `/v1/work/cloud/projects/${projectId}/directory`, headers: { "x-lori-project-client-version": "1" } });
    expect(response.statusCode).toBe(200);
    expect(directory).toHaveBeenCalledExactlyOnceWith(actor, projectId);
    directory.mockClear();
    await app.inject({ method: "GET", url: "/v1/work/cloud/projects/invalid/directory", headers: { "x-lori-project-client-version": "1" } });
    expect(directory).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it("does not reach the directory with an unsupported desktop protocol", async () => {
  const app = Fastify(), directory = vi.fn();
  registerProjectRoutes(app, { actor: async () => ({ deviceId: "device" }), config: { cloud: { desktopProjectsEnabled: true } }, projects: { directory } } as unknown as CloudWorkService);
  try {
    const response = await app.inject({ method: "GET", url: `/v1/work/cloud/projects/${projectId}/directory` });
    expect(response.statusCode).not.toBe(200);
    expect(directory).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
