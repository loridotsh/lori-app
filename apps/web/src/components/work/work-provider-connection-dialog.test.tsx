import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkProviderConnectionDialog } from "./work-provider-connection-dialog";
import { workApi } from "@/lib/work-api";
import { ClientApiError } from "@/lib/client-api";
vi.mock("@/lib/work-api", () => ({ workApi: vi.fn() }));
const props = () => ({
  providerId: "openai",
  providerName: "OpenAI",
  revision: 7,
  onClose: vi.fn(),
  onSaved: vi.fn(),
  onReviewLatest: vi.fn(),
});
function submit() {
  fireEvent.change(screen.getByLabelText("Provider API key"), {
    target: { value: "secret-not-for-display" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save company connection" }),
  );
}
beforeEach(() => vi.mocked(workApi).mockReset());
describe("company key dialog", () => {
  it("focuses the key field when the dialog opens", () => {
    render(<WorkProviderConnectionDialog {...props()} />);
    expect(document.activeElement).toBe(
      screen.getByLabelText("Provider API key"),
    );
  });
  it("prevents duplicate submits, clears the secret immediately, and never posts Code models", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(workApi).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const p = props();
    render(<WorkProviderConnectionDialog {...p} />);
    submit();
    expect(
      (screen.getByLabelText("Provider API key") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(workApi).toHaveBeenCalledOnce();
    expect(
      JSON.parse(vi.mocked(workApi).mock.calls[0]![1]!.body as string),
    ).toEqual({
      apiKey: "secret-not-for-display",
      expectedRevision: 7,
      providerId: "openai",
      requestsPerMinute: 60,
    });
    resolve({
      id: "g",
      providerId: "openai",
      providerName: "OpenAI",
      credentialConfigured: true,
      requestsPerMinute: 60,
      policyRevision: 8,
    });
    await waitFor(() => expect(p.onSaved).toHaveBeenCalledOnce());
  });
  it.each([401, 403, 409])(
    "recovers status %s without echoing errors or discarding the parent draft",
    async (status) => {
      vi.mocked(workApi).mockRejectedValueOnce(
        new ClientApiError("error", "secret-not-for-display", status),
      );
      const p = props();
      render(<WorkProviderConnectionDialog {...p} />);
      submit();
      await screen.findByRole("alert");
      expect(document.body.textContent).not.toContain("secret-not-for-display");
      expect(p.onClose).not.toHaveBeenCalled();
      if (status === 401) {
        expect(
          screen
            .getByRole("link", { name: "Sign in again" })
            .getAttribute("target"),
        ).toBe("_blank");
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
        expect(p.onReviewLatest).toHaveBeenCalledOnce();
      }
    },
  );
  it("treats a timeout as unknown outcome and requires explicit status recovery", async () => {
    vi.mocked(workApi).mockRejectedValueOnce(
      new ClientApiError("request_timeout", "timeout", 0),
    );
    const p = props();
    render(<WorkProviderConnectionDialog {...p} />);
    submit();
    await screen.findByText(/save outcome is unknown/);
    expect(
      (
        screen.getByRole("button", {
          name: "Save company connection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(p.onClose).not.toHaveBeenCalled();
    expect(workApi).toHaveBeenCalledOnce();
  });
  it("respects rate-limit waiting without automatically retrying a credential write", async () => {
    vi.mocked(workApi).mockRejectedValueOnce(
      new ClientApiError(
        "rate_limited",
        "secret-not-for-display",
        429,
        undefined,
        30,
      ),
    );
    render(<WorkProviderConnectionDialog {...props()} />);
    submit();
    await screen.findByText(/Try again in/);
    fireEvent.change(screen.getByLabelText("Provider API key"), {
      target: { value: "replacement" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Save company connection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(workApi).toHaveBeenCalledOnce();
  });
});

it("updates a shared request limit without requiring or resending the existing key", async () => {
  const connection = {
    id: "g",
    providerId: "openai",
    providerName: "OpenAI",
    credentialConfigured: true as const,
    requestsPerMinute: 90,
    policyRevision: 7,
    createdAt: "date",
    updatedAt: "date",
  };
  vi.mocked(workApi).mockResolvedValueOnce({
    ...connection,
    requestsPerMinute: 120,
    policyRevision: 8,
  });
  const p = props();
  render(<WorkProviderConnectionDialog {...p} connection={connection} />);
  expect(
    (
      screen.getByRole("button", {
        name: "Save connection limit",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByText("Request limit"));
  fireEvent.change(screen.getByLabelText("Requests per minute"), {
    target: { value: "120" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save connection limit" }),
  );
  await waitFor(() => expect(p.onSaved).toHaveBeenCalledOnce());
  expect(
    JSON.parse(vi.mocked(workApi).mock.calls[0]![1]!.body as string),
  ).toEqual({ expectedRevision: 7, requestsPerMinute: 120 });
  expect(
    (screen.getByLabelText("New API key") as HTMLInputElement).maxLength,
  ).toBe(8192);
});
it("rejects out-of-range shared request limits before any request", () => {
  render(<WorkProviderConnectionDialog {...props()} />);
  fireEvent.change(screen.getByLabelText("Provider API key"), {
    target: { value: "example-key" },
  });
  fireEvent.click(screen.getByText("Request limit"));
  for (const value of ["0", "601", "1.5"]) {
    fireEvent.change(screen.getByLabelText("Requests per minute"), {
      target: { value },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Save company connection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  }
  expect(workApi).not.toHaveBeenCalled();
});
it("shows a recoverable field error on400 while clearing only the credential", async () => {
  vi.mocked(workApi).mockRejectedValueOnce(
    new ClientApiError(
      "invalid_provider_credential",
      "secret-not-for-display",
      400,
    ),
  );
  render(<WorkProviderConnectionDialog {...props()} />);
  fireEvent.click(screen.getByText("Request limit"));
  fireEvent.change(screen.getByLabelText("Requests per minute"), {
    target: { value: "90" },
  });
  submit();
  await screen.findByText(/Re-enter the key/);
  expect(
    (screen.getByLabelText("Requests per minute") as HTMLInputElement).value,
  ).toBe("90");
  expect(
    (screen.getByLabelText("Provider API key") as HTMLInputElement).value,
  ).toBe("");
  expect(document.body.textContent).not.toContain("secret-not-for-display");
});

it("projects only public metadata and the known provider name after a successful key write", async () => {
  vi.mocked(workApi).mockResolvedValueOnce({
    id: "g",
    providerId: "openai",
    providerName: "secret-not-for-display",
    credentialConfigured: true,
    requestsPerMinute: 60,
    policyRevision: 8,
    apiKey: "secret-not-for-display",
  });
  const p = props();
  render(<WorkProviderConnectionDialog {...p} />);
  submit();
  await waitFor(() => expect(p.onSaved).toHaveBeenCalledOnce());
  expect(p.onSaved.mock.calls[0]![0].providerName).toBe("OpenAI");
  expect(p.onSaved.mock.calls[0]![0].apiKey).toBeUndefined();
  expect(document.body.textContent).not.toContain("secret-not-for-display");
});
