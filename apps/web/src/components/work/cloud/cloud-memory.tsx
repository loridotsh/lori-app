"use client";

import type {
  CloudMemoryNote,
  CloudMemorySettings,
} from "@lori-enterprise/contracts";
import { BrainIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel, SettingsRow } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";

const MAX_CONTENT_BYTES = 12000;
type Edit = {
  id: string | null;
  revision: number | null;
  topic: string;
  content: string;
  sensitive: boolean;
};
const empty: Edit = {
  id: null,
  revision: null,
  topic: "",
  content: "",
  sensitive: false,
};

function provenance(note: CloudMemoryNote) {
  return [
    note.provenance === "approved_tool"
      ? "Saved with your approval"
      : "Added manually",
    note.sensitive ? "Sensitive" : null,
    note.sourceMessageId ? "Conversation source recorded" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function CloudMemory({
  conversationId,
  conversationTitle,
  onFailure,
  onDirtyChange,
  onBusyChange,
}: {
  conversationId: string | null;
  conversationTitle?: string;
  onFailure: (failure: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<CloudMemorySettings | null>(null);
  const [notes, setNotes] = useState<CloudMemoryNote[]>([]);
  const [scope, setScope] = useState<"personal" | "conversation">("personal");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [editing, setEditing] = useState<Edit | null>(null);
  const [original, setOriginal] = useState<Edit | null>(null);
  const [deleting, setDeleting] = useState<CloudMemoryNote | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const generation = useRef(0);
  const dirty =
    !!editing && JSON.stringify(editing) !== JSON.stringify(original);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, busy]);
  /** A silent load refreshes in place without flashing the list or clearing messages. */
  const load = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      const version = ++generation.current;
      if (!silent) {
        setLoading(true);
        setError("");
      }
      try {
        const nextSettings = await cloudApi<CloudMemorySettings>(
          "/memory/settings",
          { signal },
        );
        if (signal?.aborted || version !== generation.current) return;
        setSettings(nextSettings);
        if (!nextSettings.allowed) {
          setNotes([]);
          return;
        }
        if (scope === "conversation" && !conversationId) {
          setNotes([]);
          return;
        }
        const params = new URLSearchParams({
          scope,
          ...(scope === "conversation" && conversationId
            ? { conversationId }
            : {}),
          ...(query.trim() ? { q: query.trim() } : {}),
        });
        const response = await cloudApi<{ notes: CloudMemoryNote[] }>(
          `/memory?${params}`,
          { signal },
        );
        if (!signal?.aborted && version === generation.current)
          setNotes(response.notes);
      } catch (failure) {
        if (!signal?.aborted && version === generation.current) {
          if (!silent) setError(cloudError(failure));
          onFailure(failure);
        }
      } finally {
        if (!signal?.aborted && version === generation.current)
          setLoading(false);
      }
    },
    [scope, conversationId, query, onFailure],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => void load(controller.signal),
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [load, query]);
  useEffect(() => {
    const refresh = () => {
      if (!busy && !dirty) void load(undefined, true);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load, busy, dirty]);
  const closeEditor = () => {
    if (dirty && !window.confirm("Discard your unsaved memory changes?"))
      return false;
    setEditing(null);
    setOriginal(null);
    setUncertain(false);
    setError("");
    return true;
  };
  const begin = (note?: CloudMemoryNote) => {
    if (dirty && !window.confirm("Discard your unsaved memory changes?"))
      return;
    const edit = note
      ? {
          id: note.id,
          revision: note.revision,
          topic: note.topic,
          content: note.content,
          sensitive: note.sensitive,
        }
      : { ...empty };
    setEditing(edit);
    setOriginal(edit);
    setDeleting(null);
    setError("");
    setUncertain(false);
  };
  const mutationFailure = (failure: unknown) => {
    setError(cloudError(failure));
    if (
      !(failure instanceof ClientApiError) ||
      failure.status === 0 ||
      failure.status >= 500
    )
      setUncertain(true);
    onFailure(failure);
  };
  const conversationScope = scope === "conversation";
  const noConversation = conversationScope && !conversationId;
  return (
    <section aria-labelledby="cloud-memory-heading" className="space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="space-y-1">
        <h3 id="cloud-memory-heading" className="text-sm font-semibold">
          Memory
        </h3>
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          Private notes Lori can remember for your work. Personal notes apply
          across your cloud conversations. Conversation notes stay with the
          selected conversation.
        </p>
      </div>
      {loading && !settings ? (
        <div role="status" className="space-y-2" aria-label="Loading memory">
          <div className="h-16 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />
          <div className="h-9 w-2/3 animate-pulse rounded-md bg-secondary motion-reduce:animate-none" />
        </div>
      ) : settings ? (
        <>
          <Panel className="border-0 bg-transparent [&>div]:px-0 [&>div]:pt-1">
            <SettingsRow
              label="Use memory in Cloud Work"
              description={
                !settings.allowed
                  ? "Your organization has disabled cloud memory."
                  : settings.enabled
                    ? "Lori can recall and learn notes during cloud conversations."
                    : "Lori will not use these notes. You can still review, edit, and delete your saved memory."
              }
            >
              <Toggle
                aria-label="Use memory in Cloud Work"
                checked={settings.enabled && settings.allowed}
                disabled={busy || !settings.allowed || uncertain}
                onChange={async (next) => {
                  setBusy(true);
                  setError("");
                  try {
                    const saved = await cloudApi<CloudMemorySettings>(
                      "/memory/settings",
                      cloudMutation(
                        {
                          enabled: next,
                          expectedRevision: settings.revision,
                        },
                        "PATCH",
                      ),
                    );
                    setSettings(saved);
                    setAnnouncement(
                      `Cloud memory ${saved.enabled ? "enabled" : "disabled"}.`,
                    );
                  } catch (failure) {
                    mutationFailure(failure);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </SettingsRow>
          </Panel>
          {settings.allowed && (
            <>
              <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-end @2xl:justify-between">
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground @2xl:w-60">
                  Scope
                  <SelectWrapper>
                    <Select
                      aria-label="Memory scope"
                      value={scope}
                      disabled={busy}
                      onChange={(event) => {
                        if (!closeEditor()) return;
                        setScope(event.target.value as typeof scope);
                        setDeleting(null);
                        setQuery("");
                      }}
                    >
                      <option value="personal">Personal</option>
                      <option value="conversation" disabled={!conversationId}>
                        {conversationId
                          ? `Conversation: ${conversationTitle ?? "Current conversation"}`
                          : "Conversation (open one first)"}
                      </option>
                    </Select>
                  </SelectWrapper>
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative min-w-0 flex-1 @2xl:w-48 @2xl:flex-none">
                    <SearchIcon
                      aria-hidden
                      className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label="Search memory"
                      placeholder="Search memory"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      maxLength={500}
                      className="pl-8"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy || loading || uncertain || noConversation}
                    onClick={() => begin()}
                  >
                    <PlusIcon aria-hidden />
                    Add memory
                  </Button>
                </div>
              </div>
              {editing && (
                <Panel>
                  <form
                    className="space-y-4 p-4 sm:p-5"
                    aria-label={editing.id ? "Edit memory" : "Add memory"}
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (
                        !editing.topic.trim() ||
                        !editing.content.trim() ||
                        uncertain
                      )
                        return;
                      if (
                        new TextEncoder().encode(editing.content.trim())
                          .length > MAX_CONTENT_BYTES
                      ) {
                        setError(
                          "Memory content must be 12,000 bytes or smaller. Shorten this note before saving.",
                        );
                        return;
                      }
                      setBusy(true);
                      setError("");
                      try {
                        const payload = {
                          requestId: crypto.randomUUID(),
                          topic: editing.topic.trim(),
                          content: editing.content.trim(),
                          sensitive: editing.sensitive,
                          ...(editing.id
                            ? { expectedRevision: editing.revision }
                            : {
                                scope,
                                ...(conversationScope && conversationId
                                  ? { conversationId }
                                  : {}),
                              }),
                        };
                        await cloudApi<CloudMemoryNote>(
                          editing.id
                            ? `/memory/${encodeURIComponent(editing.id)}`
                            : "/memory",
                          cloudMutation(payload, editing.id ? "PATCH" : "POST"),
                        );
                        setEditing(null);
                        setOriginal(null);
                        setUncertain(false);
                        setAnnouncement("Memory saved.");
                        await load(undefined, true);
                      } catch (failure) {
                        mutationFailure(failure);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <h4 className="text-sm font-medium">
                      {editing.id ? "Edit memory" : "Add memory"}
                    </h4>
                    <label className="grid gap-1.5 text-xs font-medium">
                      Topic
                      <Input
                        autoFocus
                        value={editing.topic}
                        onChange={(event) =>
                          setEditing({ ...editing, topic: event.target.value })
                        }
                        required
                        maxLength={160}
                        disabled={busy || uncertain}
                      />
                    </label>
                    <label className="grid gap-1.5 text-xs font-medium">
                      Content
                      <Textarea
                        rows={4}
                        value={editing.content}
                        onChange={(event) =>
                          setEditing({
                            ...editing,
                            content: event.target.value,
                          })
                        }
                        required
                        maxLength={MAX_CONTENT_BYTES}
                        disabled={busy || uncertain}
                      />
                    </label>
                    <div className="flex items-start justify-between gap-4 rounded-md bg-secondary/50 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Sensitive</p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          Keep for manual review only. Sensitive notes are
                          excluded from automatic context and model memory
                          tools.
                        </p>
                      </div>
                      <Toggle
                        aria-label="Sensitive — keep for manual review only"
                        checked={editing.sensitive}
                        disabled={busy || uncertain}
                        onChange={(next) =>
                          setEditing({ ...editing, sensitive: next })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={
                          busy ||
                          uncertain ||
                          !editing.topic.trim() ||
                          !editing.content.trim()
                        }
                      >
                        {busy ? "Saving…" : "Save memory"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={closeEditor}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                </Panel>
              )}
              {loading ? (
                <div
                  role="status"
                  aria-label="Loading notes"
                  className="space-y-2"
                >
                  <div className="h-14 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />
                  <div className="h-14 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />
                </div>
              ) : notes.length ? (
                <Panel>
                  <ul className="divide-y divide-border/60">
                    {notes.map((note) => (
                      <li key={note.id} className="px-4 py-4 sm:px-5">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h4 className="break-words text-sm font-medium">
                              {note.topic}
                            </h4>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                              {note.content}
                            </p>
                            <p className="mt-2 text-[11px] text-muted-foreground">
                              {provenance(note)}
                            </p>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${note.topic}`}
                              disabled={busy || uncertain}
                              onClick={() => begin(note)}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Delete ${note.topic}`}
                              disabled={busy || uncertain}
                              onClick={() => setDeleting(note)}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                        {deleting?.id === note.id && (
                          <div
                            role="group"
                            aria-label={`Confirm deleting ${note.topic}`}
                            className="mt-3 rounded-md bg-secondary/50 p-3"
                          >
                            <p className="text-sm">
                              Delete this saved memory? This cannot be undone.
                            </p>
                            <div className="mt-2 flex gap-2">
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={busy || uncertain}
                                onClick={async () => {
                                  setBusy(true);
                                  setError("");
                                  try {
                                    await cloudApi(
                                      `/memory/${encodeURIComponent(note.id)}?expectedRevision=${note.revision}`,
                                      { method: "DELETE" },
                                    );
                                    setDeleting(null);
                                    if (editing?.id === note.id) {
                                      setEditing(null);
                                      setOriginal(null);
                                    }
                                    setAnnouncement("Memory deleted.");
                                    await load(undefined, true);
                                  } catch (failure) {
                                    mutationFailure(failure);
                                  } finally {
                                    setBusy(false);
                                  }
                                }}
                              >
                                Delete memory
                              </Button>
                              <Button
                                autoFocus
                                size="sm"
                                variant="ghost"
                                onClick={() => setDeleting(null)}
                              >
                                Keep memory
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : (
                <Panel>
                  <EmptyState
                    icon={BrainIcon}
                    title={
                      query
                        ? "No matching memory"
                        : noConversation
                          ? "No conversation selected"
                          : "No saved memory in this scope"
                    }
                    description={
                      query
                        ? "Try a different search."
                        : noConversation
                          ? "Open a conversation to manage its notes."
                          : "Notes you add, or approve Lori to save, appear here."
                    }
                  />
                </Panel>
              )}
            </>
          )}
        </>
      ) : null}
      {(error || uncertain) && (
        <div role="alert" className="space-y-2 text-sm">
          {error && <p className="text-destructive">{error}</p>}
          {uncertain && (
            <p className="text-xs leading-5 text-muted-foreground">
              The change may have been saved. Your draft is kept. Reload saved
              memory to verify the result before making another change.
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || loading}
            onClick={async () => {
              await load();
              if (!editing) setUncertain(false);
            }}
          >
            Reload saved memory
          </Button>
          {uncertain && editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard
                  .writeText(`${editing.topic}\n\n${editing.content}`)
                  .then(() => setAnnouncement("Memory draft copied."))
                  .catch(() => setError("Could not copy the draft. Try again."))
              }
            >
              Copy draft
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
