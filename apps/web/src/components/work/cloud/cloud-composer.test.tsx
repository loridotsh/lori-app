import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudComposer } from "./cloud-composer";

afterEach(cleanup);
const defaults = {
  value: "A task",
  onChange: vi.fn(),
  textareaRef: createRef<HTMLTextAreaElement>(),
  disabled: false,
  controlsDisabled: false,
  sendDisabled: false,
  running: false,
  stopDisabled: false,
  onStop: vi.fn(),
  providers: [
    {
      gatewayId: "company-a",
      providerId: "openai",
      name: "Company A",
      modelIds: ["shared-model"],
    },
    {
      gatewayId: "company-b",
      providerId: "anthropic",
      name: "Company B",
      modelIds: ["shared-model", "other-model"],
    },
  ],
  gatewayId: "company-a",
  modelId: "shared-model",
  onModel: vi.fn(),
  files: [],
  attachments: [],
  onRemoveAttachment: vi.fn(),
  filesAvailable: true,
  onUpload: vi.fn(),
  onFiles: vi.fn(),
  fileDirty: false,
};

describe("Cloud Work composer", () => {
  it("does not offer an upload action to read-only project members", () => {
    render(<CloudComposer {...defaults} canUpload={false} />);
    expect(screen.queryByRole("button", { name: "Upload file" })).toBeNull();
  });
  it("keeps upload available without showing an empty file workspace", () => {
    render(<CloudComposer {...defaults} />);
    expect(screen.queryByRole("button", { name: "Open conversation files" })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload file" })).toBeTruthy();
  });
  it("selects the exact company gateway with one model picker", async () => {
    const onModel = vi.fn();
    render(<CloudComposer {...defaults} onModel={onModel} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose model" }));
    const options = await screen.findAllByRole("menuitemradio", {
      name: "shared-model",
    });
    expect(options).toHaveLength(2);
    await user.click(options[1]!);
    expect(onModel).toHaveBeenCalledExactlyOnceWith(
      "company-b",
      "shared-model",
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("sends on Enter and keeps Shift Enter, IME and an active response from resubmitting", () => {
    const submit = vi.fn((event) => event.preventDefault());
    const props = {
      ...defaults,
      textareaRef: createRef<HTMLTextAreaElement>(),
    };
    const view = render(
      <form onSubmit={submit}>
        <CloudComposer {...props} />
      </form>,
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
    view.rerender(
      <form onSubmit={submit}>
        <CloudComposer {...props} running />
      </form>,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("keeps Stop available while a file read temporarily disables editing", async () => {
    const onStop = vi.fn();
    const submit = vi.fn();
    render(
      <form onSubmit={submit}>
        <CloudComposer
          {...defaults}
          disabled
          controlsDisabled
          running
          onStop={onStop}
        />
      </form>,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Stop response" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
  it("grows with long drafts and shrinks after clearing", () => {
    const textareaRef = createRef<HTMLTextAreaElement>();
    const view = render(
      <CloudComposer {...defaults} textareaRef={textareaRef} value="" />,
    );
    const input = textareaRef.current!;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    view.rerender(
      <CloudComposer
        {...defaults}
        textareaRef={textareaRef}
        value="Many lines"
      />,
    );
    expect(input.style.height).toBe("200px");
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      value: 24,
    });
    view.rerender(
      <CloudComposer {...defaults} textareaRef={textareaRef} value="" />,
    );
    expect(input.style.height).toBe("48px");
  });
});
