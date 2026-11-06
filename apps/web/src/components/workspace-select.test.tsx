import type { Workspace } from "@lori-enterprise/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientApi } from "@/lib/client-api";
import { WorkspaceSelect } from "./workspace-select";

vi.mock("@/lib/client-api", () => ({ clientApi: vi.fn() }));

const workspaces: Workspace[] = [
  { active: true, id: "personal", kind: "personal", name: "Personal", role: "owner" },
  { active: false, id: "acme", kind: "enterprise", name: "Acme", role: "member" },
];
const assign = vi.fn();
const reload = vi.fn();

beforeEach(() => {
  vi.mocked(clientApi).mockReset();
  assign.mockReset();
  reload.mockReset();
  vi.stubGlobal("location", { assign, reload });
});

describe("WorkspaceSelect", () => {
  it("shows the active workspace and marks the personal one", () => {
    render(<WorkspaceSelect label="Connect to" workspaces={workspaces} />);
    expect((screen.getByLabelText("Connect to") as HTMLSelectElement).value).toBe("personal");
    expect(screen.getByRole("option", { name: "Personal (just you)" })).toBeTruthy();
  });

  it("switches, then reloads the page it is on", async () => {
    vi.mocked(clientApi).mockResolvedValue({});
    render(<WorkspaceSelect label="Connect to" workspaces={workspaces} />);
    fireEvent.change(screen.getByLabelText("Connect to"), { target: { value: "acme" } });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(clientApi).toHaveBeenCalledWith(
      "/v1/workspaces/active",
      expect.objectContaining({ body: JSON.stringify({ organizationId: "acme" }), method: "POST" }),
    );
  });

  it("goes to the destination when one is given", async () => {
    vi.mocked(clientApi).mockResolvedValue({});
    render(<WorkspaceSelect destination="/" label="Switch workspace" workspaces={workspaces} />);
    fireEvent.change(screen.getByLabelText("Switch workspace"), { target: { value: "acme" } });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("says so when the switch fails, and stays usable", async () => {
    vi.mocked(clientApi).mockRejectedValue(new Error("offline"));
    render(<WorkspaceSelect label="Connect to" workspaces={workspaces} />);
    fireEvent.change(screen.getByLabelText("Connect to"), { target: { value: "acme" } });
    expect((await screen.findByRole("alert")).textContent).toContain("could not be changed");
    expect((screen.getByLabelText("Connect to") as HTMLSelectElement).disabled).toBe(false);
  });
});
