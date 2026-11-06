import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudExtensionsSnapshot } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { CloudExtensions } from "./cloud-extensions";
vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));
let snapshot: CloudExtensionsSnapshot;
let failure: unknown;
beforeEach(() => {
  failure = undefined;
  snapshot = {
    callbackUrl:
      "https://enterprise.test/v1/work/cloud/extensions/oauth/callback",
    plugins: [
      {
        id: "github",
        name: "GitHub",
        description: "Repositories and issues",
        auth: "token",
        docsUrl: "https://github.com/settings/tokens",
        setup: "Create a token with the access you need.",
        allowed: true,
        connection: null,
      },
      {
        id: "notion",
        name: "Notion",
        auth: "oauth",
        docsUrl: "https://notion.so",
        setup: "Connect your workspace.",
        allowed: true,
        connection: null,
      },
    ],
    skills: [
      {
        id: "documents",
        name: "Documents",
        description: "Create office documents",
        version: "1.0.0",
        capability: "documents",
        references: [],
        allowed: true,
        enabled: false,
      },
    ],
  };
  vi.mocked(cloudApi).mockImplementation(async (path, init) => {
    if (path === "/extensions") return structuredClone(snapshot);
    if (failure) throw failure;
    if (path.endsWith("/token")) {
      snapshot.plugins[0]!.connection = {
        id: "connection",
        revision: 1,
        status: "connected",
        enabled: true,
        toolCount: 3,
        resourceCount: 1,
        updatedAt: "2026-10-11T00:00:00Z",
      };
      return {};
    }
    if (path.endsWith("/oauth"))
      return {
        connectionId: "oauth",
        authorizationUrl: "https://provider.test/authorize?state=opaque",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    if (path.includes("/skills/")) {
      snapshot.skills[0]!.enabled = JSON.parse(String(init?.body)).enabled;
      return {};
    }
    if (init?.method === "DELETE") {
      snapshot.plugins[0]!.connection = null;
      return {};
    }
    if (init?.method === "PATCH") {
      snapshot.plugins[0]!.connection!.enabled = JSON.parse(
        String(init?.body),
      ).enabled;
      return {};
    }
    throw new Error(path);
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
async function open() {
  render(<CloudExtensions onFailure={vi.fn()} />);
  await screen.findByRole("button", { name: /GitHub/ });
}
describe("Cloud extensions", () => {
  it("connects with a transient token and uses the saved connection revision", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with API token" }),
    );
    const input = screen.getByLabelText("GitHub API token") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "synthetic-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(input.value).toBe("");
    await screen.findByText("3 tools · 1 resources");
    expect(screen.queryByDisplayValue("synthetic-token")).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", { name: "Use GitHub in Cloud Work" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(([, init]) => init?.method === "PATCH"),
      ).toBe(true),
    );
    const patch = vi
      .mocked(cloudApi)
      .mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      expectedRevision: 1,
      enabled: false,
    });
  });
  it("never replays credentials after an uncertain connection outcome", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with API token" }),
    );
    fireEvent.change(screen.getByLabelText("GitHub API token"), {
      target: { value: "synthetic-token" },
    });
    failure = new ClientApiError("offline", "Offline", 0);
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await screen.findByRole("button", { name: "Reload status" });
    expect(screen.queryByDisplayValue("synthetic-token")).toBeNull();
    failure = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Reload status" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Connect with API token" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(
      vi
        .mocked(cloudApi)
        .mock.calls.filter(([path]) => path.endsWith("/token")),
    ).toHaveLength(1);
  });
  it("offers a safe authorization link after server-owned OAuth setup", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Notion/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    const link = await screen.findByRole("link", {
      name: "Continue to Notion",
    });
    expect(link.getAttribute("href")).toBe(
      "https://provider.test/authorize?state=opaque",
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("keeps the connect action visible with an explanation when a callback is unavailable", async () => {
    snapshot.callbackUrl = null;
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Notion/ }));
    expect(
      screen
        .getByRole("button", { name: "Connect account" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(/Account sign-in needs a secure callback/),
    ).toBeTruthy();
  });
  it("requires confirmation to disconnect and toggles actual bundled skills", async () => {
    snapshot.plugins[0]!.connection = {
      id: "connection",
      revision: 4,
      status: "connected",
      enabled: true,
      toolCount: 3,
      resourceCount: 0,
      updatedAt: "2026-10-11T00:00:00Z",
    };
    await open();
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      vi
        .mocked(cloudApi)
        .mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect plugin" }));
    await screen.findByRole("button", { name: "Connect with API token" });
    const deletion = vi
      .mocked(cloudApi)
      .mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({
      expectedRevision: 4,
    });
    fireEvent.click(screen.getByRole("button", { name: "All plugins" }));
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.click(screen.getByRole("switch", { name: "Enable Documents" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(
            ([path, init]) =>
              path === "/extensions/skills/documents" &&
              init?.method === "PATCH",
          ),
      ).toBe(true),
    );
  });
  it("releases navigation after an unknown mutation without replaying credentials", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let failConnect!: (reason: unknown) => void;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path.endsWith("/token"))
        return new Promise((_resolve, reject) => {
          failConnect = reject;
        });
      return original(path, init);
    });
    const onBusyChange = vi.fn();
    render(<CloudExtensions onFailure={vi.fn()} onBusyChange={onBusyChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with API token" }),
    );
    fireEvent.change(screen.getByLabelText("GitHub API token"), {
      target: { value: "synthetic-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    await act(async () => {
      failConnect(new ClientApiError("request_timeout", "Timed out", 0));
    });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByText(/The change may have been received/)).toBeTruthy();
    expect(
      vi
        .mocked(cloudApi)
        .mock.calls.filter(([path]) => path.endsWith("/token")),
    ).toHaveLength(1);
    const settledUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
  });
  it("clears a pending extension mutation busy callback on unmount", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let finishConnect!: (value: unknown) => void;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path.endsWith("/token"))
        return new Promise((resolve) => {
          finishConnect = resolve;
        });
      return original(path, init);
    });
    const onBusyChange = vi.fn();
    const rendered = render(
      <CloudExtensions onFailure={vi.fn()} onBusyChange={onBusyChange} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Connect with API token" }),
    );
    fireEvent.change(screen.getByLabelText("GitHub API token"), {
      target: { value: "synthetic-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    rendered.unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      finishConnect({});
    });
  });
  it("shows registered-app credentials with the exact callback URL", async () => {
    snapshot.plugins[1] = {
      ...snapshot.plugins[1]!,
      id: "asana",
      name: "Asana",
      auth: "registeredOAuth",
    };
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Asana/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
    expect(screen.getByText(snapshot.callbackUrl!)).toBeTruthy();
    expect(screen.getByLabelText("OAuth client ID")).toBeTruthy();
    expect(
      screen.getByLabelText("OAuth client secret").getAttribute("type"),
    ).toBe("password");
  });
  it("can restart or cancel an abandoned OAuth sign-in after a reload", async () => {
    snapshot.plugins[1]!.connection = {
      id: "oauth",
      status: "connecting",
      enabled: false,
      revision: 3,
      toolCount: 0,
      resourceCount: 0,
      updatedAt: new Date().toISOString(),
    };
    await open();
    fireEvent.click(screen.getByRole("button", { name: /Notion/ }));
    expect(
      screen.getByRole("button", { name: "Restart sign-in" }),
    ).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(
            ([path, init]) =>
              path === "/extensions/plugins/notion" &&
              init?.method === "DELETE" &&
              JSON.parse(String(init.body)).expectedRevision === 3,
          ),
      ).toBe(true),
    );
  });
  it("automatically observes OAuth completion without replaying authorization", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await open();
      fireEvent.click(screen.getByRole("button", { name: /Notion/ }));
      fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
      await screen.findByRole("link", { name: "Continue to Notion" });
      snapshot.plugins[1]!.connection = {
        id: "oauth",
        status: "connected",
        enabled: true,
        revision: 1,
        toolCount: 5,
        resourceCount: 0,
        updatedAt: new Date().toISOString(),
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(
        screen.getByRole("switch", { name: "Use Notion in Cloud Work" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("link", { name: "Continue to Notion" }),
      ).toBeNull();
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.filter(([path]) => path.endsWith("/oauth")),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("validates a connected provider on Refresh status using its saved revision", async () => {
    snapshot.plugins[0]!.connection = {
      id: "connection",
      status: "connected",
      enabled: true,
      revision: 7,
      toolCount: 3,
      resourceCount: 0,
      updatedAt: new Date().toISOString(),
    };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) =>
      path.endsWith("/refresh") ? {} : original(path, init),
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(
            ([path, init]) =>
              path === "/extensions/plugins/github/refresh" &&
              init?.method === "POST" &&
              JSON.parse(String(init.body)).expectedRevision === 7,
          ),
      ).toBe(true),
    );
  });
  it("ignores an older snapshot that finishes after a newer refresh", async () => {
    let finish!: (value: unknown) => void;
    const stale = structuredClone(snapshot);
    vi.mocked(cloudApi).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<CloudExtensions onFailure={vi.fn()} />);
    snapshot.plugins[0]!.connection = {
      id: "connection",
      status: "connected",
      enabled: true,
      revision: 8,
      toolCount: 3,
      resourceCount: 0,
      updatedAt: new Date().toISOString(),
    };
    fireEvent.focus(window);
    await screen.findByRole("button", { name: /GitHub.*Connected/ });
    await act(async () => finish(stale));
    expect(
      screen.getByRole("button", { name: /GitHub.*Connected/ }),
    ).toBeTruthy();
  });
});
