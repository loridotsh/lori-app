"use client";

import type { CloudCapabilities, CloudFile } from "@lori-enterprise/contracts";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FolderIcon,
  ImageIcon,
  PaperclipIcon,
  SquareIcon,
  VideoIcon,
} from "lucide-react";
import { useCallback, useId, useLayoutEffect, useMemo, useState, type RefObject, type ReactNode } from "react";
import { AttachmentChips, type UploadProgress } from "./composer/attachment-chips";
import { MentionPicker, useMentionOptions } from "./composer/mention-picker";
import {
  applyMention,
  filterMentions,
  findMentionQuery,
  type MentionOption,
} from "./composer/mentions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatTokenCount } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";

type Provider = CloudCapabilities["providers"][number];
const MODEL_SEARCH_THRESHOLD = 8;

/** One provider's models under Chat, Images and Videos, leaving out any heading with nothing in it. */
function modelSections(item: Provider, models: string[]) {
  const ofKind = (kind?: "image" | "video") => models.filter((model) => item.modelMedia?.[model]?.kind === kind);
  return [
    { label: item.name, models: ofKind() },
    { label: `${item.name} images`, models: ofKind("image") },
    { label: `${item.name} videos`, models: ofKind("video") },
  ].filter((section) => section.models.length > 0);
}

/** The Cloud host uses Lori's compact Work composer, with explicit cloud files. */
export function CloudComposer({
  value,
  onChange,
  textareaRef,
  disabled,
  controlsDisabled,
  sendDisabled,
  disabledReason,
  running,
  stopDisabled,
  onStop,
  providers,
  gatewayId,
  modelId,
  onModel,
  files,
  attachments,
  onRemoveAttachment,
  filesAvailable,
  canUpload = true,
  onUpload,
  onFiles,
  approvalControl,
  fileDirty,
  uploading = null,
  onPasteFiles,
  extensionsAvailable = false,
  projectId,
}: {
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  controlsDisabled: boolean;
  sendDisabled: boolean;
  disabledReason?: string;
  running: boolean;
  stopDisabled: boolean;
  onStop: () => void;
  providers: Provider[];
  gatewayId: string;
  modelId: string;
  onModel: (gatewayId: string, modelId: string) => void;
  files: CloudFile[];
  attachments: string[];
  onRemoveAttachment: (id: string) => void;
  filesAvailable: boolean;
  canUpload?: boolean;
  onUpload: () => void;
  onFiles: () => void;
  approvalControl?: ReactNode;
  fileDirty: boolean;
  /** Progress of an upload in flight, shown beside the attached files. */
  uploading?: UploadProgress | null;
  /** Files or screenshots pasted into the message; absent when files are unavailable. */
  onPasteFiles?: (files: File[]) => void;
  /** Whether plugins and skills can be mentioned. */
  extensionsAvailable?: boolean;
  projectId?: string;
}) {
  // @-mentions: what is being typed after the caret's "@", and what it could be.
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const query = useMemo(
    () => (disabled ? null : findMentionQuery(value, Math.min(caret, value.length))),
    [value, caret, disabled],
  );
  const [modelQuery, setModelQuery] = useState("");
  const focusModelSearch = useCallback((input: HTMLInputElement | null) => {
    if (input) requestAnimationFrame(() => input.focus());
  }, []);
  const searchableModels = providers.reduce((total, item) => total + item.modelIds.length, 0) > MODEL_SEARCH_THRESHOLD;
  const modelTerm = modelQuery.trim().toLowerCase();
  const modelGroups = providers
    .map((item) => ({ item, models: item.modelIds.filter((model) => model.toLowerCase().includes(modelTerm)) }))
    .filter(({ models }) => models.length > 0);
  const pickerOpen = focused && !!query && dismissed !== query.start;
  const mentionOptions = useMentionOptions(files, extensionsAvailable, pickerOpen, projectId);
  const matches = useMemo(
    () => (query ? filterMentions(mentionOptions, query.query) : []),
    [mentionOptions, query],
  );
  const pick = (option: MentionOption) => {
    if (!query) return;
    const next = applyMention(value, query, option);
    if (next.text.length > 60000) return;
    onChange(next.text);
    setCaret(next.caret);
    setActiveIndex(0);
    // Put the caret after the inserted mention once the value has rendered.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  useLayoutEffect(() => {
    const resize = () => {
      const input = textareaRef.current;
      if (!input) return;
      input.style.height = "0px";
      input.style.height = `${Math.max(48, input.scrollHeight)}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    const parent = textareaRef.current?.parentElement;
    if (parent) observer?.observe(parent);
    return () => {
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, [value, textareaRef]);

  const provider = providers.find((item) => item.gatewayId === gatewayId);
  const modelMedia = provider?.modelMedia?.[modelId];
  const selection = JSON.stringify([gatewayId, modelId]);
  const control =
    "inline-flex min-w-0 items-center gap-1.5 rounded-md text-[var(--work-muted)] outline-none transition-colors hover:bg-[var(--work-hover)] hover:text-[var(--work-ink)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-45 motion-reduce:transition-none";

  return (
    <div
      role="group"
      aria-label="Message composer"
      className="relative isolate mx-auto w-full max-w-[784px] [--work-input:#fdfdfc] [--work-header:#f1f0ed] [--work-border:#e2e1de] [--work-ink:#21201c] [--work-muted:#63635e] [--work-hover:#e9e8e6] dark:[--work-input:#292928] dark:[--work-header:#20201f] dark:[--work-border:#3b3a37] dark:[--work-ink:#eeeeec] dark:[--work-muted:#b5b3ad] dark:[--work-hover:#31312e]"
    >
      {filesAvailable && files.length > 0 && (
        <div className="mx-3 flex min-w-0 items-center rounded-t-2xl bg-[var(--work-header)] px-1.5 pb-3 pt-1">
          <button
            type="button"
            onClick={onFiles}
            disabled={controlsDisabled}
            className={cn(control, "min-h-8 px-2 text-[11px]")}
            aria-label="Open conversation files"
          >
            <FolderIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">Conversation files</span>
            {!!files.length && (
              <span className="tabular-nums text-muted-foreground">
                {files.length}
              </span>
            )}
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </button>
        </div>
      )}
      <div
        className={cn(
          "relative min-w-0 rounded-2xl border border-[var(--work-border)] bg-[var(--work-input)] p-2 focus-within:border-border-strong",
          filesAvailable && files.length > 0 && "-mt-2",
        )}
      >
        <AttachmentChips
          attachments={attachments}
          files={files}
          uploading={uploading}
          disabled={disabled}
          onRemove={onRemoveAttachment}
          controlClass={control}
        />
        {fileDirty && (
          <p role="status" className="px-2 pb-1 text-xs text-muted-foreground">
            Save or discard your file changes before sending.
          </p>
        )}
        <label htmlFor="cloud-message" className="sr-only">
          Message
        </label>
        {pickerOpen ? (
          <MentionPicker
            listboxId={listboxId}
            options={matches}
            activeIndex={Math.min(activeIndex, Math.max(0, matches.length - 1))}
            empty={
              mentionOptions.length
                ? "Nothing matches. Keep typing, or press Escape."
                : "Nothing to mention yet. Add files to this conversation, or connect a plugin."
            }
            onPick={pick}
            onHover={setActiveIndex}
          />
        ) : null}
        <p role="status" aria-live="polite" className="sr-only">
          {pickerOpen
            ? matches.length
              ? `${matches.length} suggestion${matches.length === 1 ? "" : "s"}. Use the arrow keys, then Enter to choose.`
              : "No suggestions."
            : ""}
        </p>
        <textarea
          id="cloud-message"
          ref={textareaRef}
          rows={2}
          cols={1}
          wrap="soft"
          dir="auto"
          value={value}
          onChange={(event) => {
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setDismissed(null);
            setActiveIndex(0);
            onChange(event.target.value);
          }}
          // Moving the caret (arrows, click) changes which mention, if any, is being typed.
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onPaste={(event) => {
            const pasted = [...(event.clipboardData?.files ?? [])];
            // Files and screenshots become attachments; ordinary text pastes as usual.
            if (!pasted.length || !onPasteFiles) return;
            // Copying cells from a spreadsheet or text from a page puts a rendered
            // image next to the text. When the clipboard has text and only images,
            // the text is what was meant.
            if (
              event.clipboardData?.getData("text/plain") &&
              pasted.every((file) => file.type.startsWith("image/"))
            )
              return;
            event.preventDefault();
            onPasteFiles(pasted);
          }}
          disabled={disabled}
          maxLength={60000}
          placeholder={modelMedia ? `Describe the ${modelMedia.kind} you want…` : "Ask Lori to work on something…"}
          aria-describedby="cloud-composer-hint"
          aria-controls={pickerOpen ? listboxId : undefined}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={
            pickerOpen && matches.length ? `${listboxId}-${Math.min(activeIndex, matches.length - 1)}` : undefined
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (pickerOpen) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (matches.length) {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActiveIndex((index) => (index + step + matches.length) % matches.length);
                }
                return;
              }
              if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && matches.length > 0)) {
                // Choosing a suggestion must never send the message.
                event.preventDefault();
                const chosen = matches[Math.min(activeIndex, matches.length - 1)];
                if (chosen) pick(chosen);
                else setDismissed(query?.start ?? null);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(query?.start ?? null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!sendDisabled && !running)
                event.currentTarget.form?.requestSubmit();
            }
          }}
          className="block max-h-[min(200px,28dvh)] min-h-12 w-full min-w-0 resize-none overflow-x-hidden overflow-y-auto whitespace-pre-wrap rounded-lg border-0 bg-transparent px-2 py-1 text-base leading-6 text-[var(--work-ink)] outline-none [overflow-wrap:anywhere] [scrollbar-color:var(--work-border)_transparent] [scrollbar-width:thin] placeholder:text-[var(--work-muted)] focus-visible:outline-none disabled:opacity-60 sm:text-[13px]"
        />
        <div className="flex min-w-0 items-center gap-1 pt-1">
          {providers.length ? (
            <DropdownMenu onOpenChange={(open) => { if (!open) setModelQuery(""); }}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose model"
                  disabled={controlsDisabled}
                  title={
                    provider
                      ? `${provider.name} · ${modelId}`
                      : "Choose a model"
                  }
                  className={cn(
                    control,
                    "h-11 max-w-[min(18rem,calc(100%_-_96px))] px-2 text-xs sm:h-8",
                  )}
                >
                  {modelMedia?.kind === "image" ? <ImageIcon aria-hidden className="size-3.5 shrink-0" /> : null}
                  {modelMedia?.kind === "video" ? <VideoIcon aria-hidden className="size-3.5 shrink-0" /> : null}
                  <span className="truncate">
                    {modelId || "Choose a model"}
                  </span>
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="max-h-[min(320px,60dvh,var(--radix-dropdown-menu-content-available-height))] w-[min(320px,calc(100vw-2rem))]"
              >
                {searchableModels ? (
                  <div className="sticky top-0 z-10 bg-popover p-1 pb-1.5">
                    <input
                      ref={focusModelSearch}
                      aria-label="Search models"
                      placeholder="Search models"
                      value={modelQuery}
                      onChange={(event) => setModelQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") return;
                        event.stopPropagation();
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
                        }
                      }}
                      className="h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                ) : null}
                {modelGroups.length === 0 ? (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    No models match.
                  </p>
                ) : null}
                <DropdownMenuRadioGroup
                  value={selection}
                  onValueChange={(key) => {
                    for (const item of providers)
                      for (const model of item.modelIds) {
                        if (JSON.stringify([item.gatewayId, model]) === key)
                          onModel(item.gatewayId, model);
                      }
                  }}
                >
                  {modelGroups.map(({ item, models }) => (
                    <div key={item.gatewayId}>
                      {modelSections(item, models).map((section) => (
                        <div key={section.label}>
                          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                            {section.label}
                          </DropdownMenuLabel>
                          {section.models.map((model) => (
                            <DropdownMenuRadioItem
                              key={model}
                              value={JSON.stringify([item.gatewayId, model])}
                              className="break-words text-[13px] [overflow-wrap:anywhere]"
                            >
                              {model}
                              {item.modelMedia?.[model] ? (
                                item.modelMedia[model]!.price ? (
                                  <span className="ml-auto shrink-0 pl-3 text-[11px] text-muted-foreground">
                                    {item.modelMedia[model]!.price}
                                  </span>
                                ) : null
                              ) : item.modelLimits?.[model] ? (
                                <span className="ml-auto pl-3 text-[11px] text-muted-foreground">
                                  {formatTokenCount(
                                    item.modelLimits[model]!.contextTokens,
                                  )}
                                </span>
                              ) : null}
                            </DropdownMenuRadioItem>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="min-w-0 truncate px-2 text-xs text-muted-foreground">
              No models available
            </span>
          )}
          {approvalControl}
          {filesAvailable && canUpload && (
            <button
              type="button"
              onClick={onUpload}
              disabled={controlsDisabled}
              aria-label="Upload file"
              title="Attach a file"
              className={cn(
                control,
                "ml-auto size-11 shrink-0 justify-center sm:size-8",
              )}
            >
              <PaperclipIcon aria-hidden className="size-4" />
            </button>
          )}
          <button
            type={running ? "button" : "submit"}
            aria-label={running ? "Stop response" : "Send"}
            title={running ? "Stop response" : disabledReason || "Send message"}
            disabled={running ? stopDisabled : sendDisabled}
            onClick={running ? onStop : undefined}
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-full bg-[var(--work-ink)] text-[var(--work-input)] outline-none transition-colors hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--work-input)] disabled:cursor-default disabled:bg-[var(--work-header)] disabled:text-[var(--work-muted)] motion-reduce:transition-none sm:size-8",
              (!filesAvailable || !canUpload) && "ml-auto",
            )}
          >
            {running ? (
              <SquareIcon aria-hidden className="size-3 fill-current" />
            ) : (
              <ArrowUpIcon aria-hidden className="size-[17px]" />
            )}
          </button>
        </div>
      </div>
      <p id="cloud-composer-hint" className="sr-only">
        {disabledReason ||
          "Enter to send. Shift and Enter for a new line. Files stay in this cloud conversation."}
      </p>
    </div>
  );
}
