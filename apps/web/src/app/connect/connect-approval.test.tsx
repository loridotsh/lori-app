import type { Viewer } from "@lori-enterprise/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectApproval } from "./connect-approval";

const { clientApiMock, MockClientApiError } = vi.hoisted(() => ({
  clientApiMock: vi.fn(),
  MockClientApiError: class extends Error {
    public constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/client-api", () => ({
  ClientApiError: MockClientApiError,
  clientApi: clientApiMock,
}));

const viewer: Viewer = {
  organization: { id: "org-1", name: "Acme" },
  role: "member",
  user: {
    email: "member@example.com",
    id: "user-1",
    name: "Member",
  },
};

const approvalProps = {
  appVersion: "1.5.4",
  callbackUrl: "http://127.0.0.1:43892/enroll/request-1",
  codeChallenge: "challenge-that-identifies-this-device-request",
  deviceName: "Lori on macOS",
  platform: "macos" as const,
  state: "state-that-binds-browser-and-desktop",
  viewer,
};

describe("ConnectApproval", () => {
  beforeEach(() => {
    clientApiMock.mockReset();
  });

  it("makes the signed-in and one-time device approval states explicit", () => {
    render(<ConnectApproval {...approvalProps} />);

    expect(screen.getByText("Signed in as member@example.com")).toBeTruthy();
    expect(screen.getByText(/One confirmation remains/i)).toBeTruthy();
    expect(screen.getByText("Lori on macOS")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve and connect Lori" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Not this device" })).toBeTruthy();
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("preserves the complete connection request when an expired session signs in again", async () => {
    const user = userEvent.setup();
    clientApiMock.mockRejectedValueOnce(
      new MockClientApiError("unauthorized", "Authentication required.", 401),
    );
    render(<ConnectApproval {...approvalProps} />);

    await user.click(
      screen.getByRole("button", { name: "Approve and connect Lori" }),
    );

    expect(
      await screen.findByText(/dashboard session expired before approval/i),
    ).toBeTruthy();
    const signInAgain = screen.getByRole("link", { name: "Sign in again" });
    const href = signInAgain.getAttribute("href");
    expect(href).toContain("/sign-in?callback=");
    const callback = new URL(href!, "https://lori.example.com").searchParams.get(
      "callback",
    );
    const restored = new URL(callback!, "https://lori.example.com");
    expect(restored.pathname).toBe("/connect");
    expect(restored.searchParams.get("challenge")).toBe(
      approvalProps.codeChallenge,
    );
    expect(restored.searchParams.get("callback_url")).toBe(
      approvalProps.callbackUrl,
    );
    expect(restored.searchParams.get("state")).toBe(approvalProps.state);
  });

  it("fails closed and clearly says the device was not connected", async () => {
    const user = userEvent.setup();
    clientApiMock.mockRejectedValueOnce(
      new MockClientApiError(
        "internal_error",
        "The server could not complete the request.",
        500,
      ),
    );
    render(<ConnectApproval {...approvalProps} />);

    await user.click(
      screen.getByRole("button", { name: "Approve and connect Lori" }),
    );

    expect(
      await screen.findByText(/Your device is not connected/i),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve and connect Lori",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByRole("link", { name: "Sign in again" })).toBeNull();
  });

  it("prevents duplicate approvals and cancels an in-flight request when declined", () => {
    let requestSignal: AbortSignal | undefined;
    clientApiMock.mockImplementationOnce(
      (_path: string, init: RequestInit | undefined) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    );
    render(<ConnectApproval {...approvalProps} />);

    const approve = screen.getByRole("button", {
      name: "Approve and connect Lori",
    });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(clientApiMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);

    fireEvent.click(screen.getByRole("link", { name: "Not this device" }));
    expect(requestSignal?.aborted).toBe(true);
  });
});
