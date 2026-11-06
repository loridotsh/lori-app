"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudFile, PersonalProjectCapabilities, PersonalProjectDetail, PersonalProjectReference } from "@lori-enterprise/contracts";
import { ArchiveIcon, DownloadIcon, EyeIcon, RotateCcwIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cloudError } from "@/lib/cloud-work-api";
import {
  getPersonalProject,
  listReferences,
  referenceContentUrl,
  referencePreviewPath,
  referenceText,
  removeReference,
  replaceReference,
  setPersonalProjectStatus,
  updatePersonalProject,
  uploadReference,
} from "@/lib/personal-projects-api";
import { DocumentPreview } from "../files/document-preview";

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const PAGE_PREVIEW = /\.(pdf|docx|pptx|doc|ppt|odt|odp|xlsx|xls|ods)$/i;
const TEXT_PREVIEW = /^text\/|json|xml|yaml|csv|markdown/i;
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const asFile = (reference: PersonalProjectReference): CloudFile => ({
  id: reference.id,
  conversationId: reference.projectId,
  path: reference.name,
  mimeType: reference.mimeType,
  sizeBytes: reference.sizeBytes,
  sha256: reference.sha256,
  version: reference.version,
  createdAt: reference.createdAt,
  updatedAt: reference.updatedAt,
});

/** Instructions, lifecycle and reference files of one personal project. Visible to its owner only. */
export function PersonalProjectPanel({
  projectId,
  capabilities,
  onChanged,
  onDirtyChange,
  onBusyChange,
  onClose,
}: {
  projectId: string;
  capabilities: PersonalProjectCapabilities | null;
  /** The project or its status changed: refresh lists. */
  onChanged: (project: PersonalProjectDetail) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState<PersonalProjectDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [references, setReferences] = useState<PersonalProjectReference[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ reference: PersonalProjectReference; text?: string; note?: string } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const replacing = useRef<PersonalProjectReference | null>(null);
  const replacer = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const adopt = useCallback((next: PersonalProjectDetail) => {
    setProject(next);
    setName(next.name);
    setDescription(next.description);
    setInstructions(next.instructions);
  }, []);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setError("");
    try {
      const loaded = await getPersonalProject(projectId);
      const files = loaded.status === "deleted" ? [] : await listReferences(projectId);
      if (version !== generation.current) return;
      adopt(loaded);
      setReferences(files);
    } catch (failure) {
      if (version === generation.current) setError(cloudError(failure));
    }
  }, [projectId, adopt]);
  useEffect(() => {
    setPreview(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const dirty = !!project && (name.trim() !== project.name || description.trim() !== project.description || instructions !== project.instructions);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError(cloudError(failure));
    } finally {
      setBusy(false);
    }
  };
  const editable = project?.status === "active";
  const save = () =>
    run(async () => {
      if (!project || !name.trim()) return;
      const next = await updatePersonalProject(project.id, { expectedRevision: project.revision, name: name.trim(), description: description.trim(), instructions });
      adopt(next);
      onChanged(next);
      setNotice("Saved. New messages use these instructions.");
    });
  const change = (status: "active" | "archived" | "deleted") =>
    run(async () => {
      if (!project) return;
      if (status === "deleted" && !window.confirm(`Delete "${project.name}" and its chats? You can restore it for ${capabilities?.recoveryDays ?? 30} days.`)) return;
      const next = await setPersonalProjectStatus(project.id, { requestId: crypto.randomUUID(), status, expectedRevision: project.revision });
      adopt(next);
      onChanged(next);
      if (status === "deleted") onClose();
      else if (project.status === "deleted") await load();
    });
  const pickPreview = (reference: PersonalProjectReference) =>
    run(async () => {
      if (PAGE_PREVIEW.test(reference.name)) return setPreview({ reference });
      if (!TEXT_PREVIEW.test(reference.mimeType) && !/\.(txt|md|csv|json|ya?ml|xml|log|py|js|ts)$/i.test(reference.name)) return setPreview({ reference, note: "No preview is available for this format. Download it to open it." });
      const result = await referenceText(reference);
      setPreview({ reference, text: result.text, note: result.truncated ? "Showing the first part of the file." : undefined });
    });
  const accept = (file: File | undefined, replace?: PersonalProjectReference | null) => {
    if (!file) return;
    if (file.size > MAX_REFERENCE_BYTES) return setError("Reference files are limited to 20 MiB.");
    void run(async () => {
      const stored = replace ? await replaceReference(replace, file, crypto.randomUUID()) : await uploadReference(projectId, file, crypto.randomUUID());
      setReferences((previous) => [...previous.filter((item) => item.id !== stored.id), stored].sort((a, b) => a.name.localeCompare(b.name)));
      setPreview(null);
      setNotice(replace ? `${stored.name} replaced (version ${stored.version}).` : `${stored.name} added.`);
    });
  };
  if (!project) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        {error ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
          </div>
        ) : (
          <p role="status">Loading project…</p>
        )}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6">
        <section aria-labelledby="personal-project-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="personal-project-heading" className="truncate text-base font-semibold">{project.name}</h2>
              <p className="text-xs text-muted-foreground">
                Only you can see this project, its instructions, chats and files.
                {project.status === "archived" ? " Archived: read-only until restored." : ""}
                {project.status === "deleted" ? ` Deleted: restore this project to recover its chats and reference files.${project.purgeAfter ? ` Recovery is available until ${new Date(project.purgeAfter).toLocaleString()}.` : ""}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              {project.status !== "active" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void change("active")}><RotateCcwIcon aria-hidden /> Restore</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void change("archived")}><ArchiveIcon aria-hidden /> Archive</Button>
              )}
              {project.status !== "deleted" && <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void change("deleted")}><Trash2Icon aria-hidden /> Delete</Button>}
            </div>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty && editable) void save();
            }}
          >
            <label className="grid gap-1.5 text-sm">
              Name
              <Input value={name} maxLength={100} disabled={busy || !editable} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">
              Description
              <Input value={description} maxLength={2000} disabled={busy || !editable} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">
              Instructions
              <Textarea
                value={instructions}
                rows={8}
                maxLength={12000}
                disabled={busy || !editable}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="How should Lori work in this project? Tone, format, background, what to avoid."
                aria-describedby="personal-instructions-help"
              />
              <span id="personal-instructions-help" className="text-xs text-muted-foreground">
                Applies to every chat in this project, below Lori&apos;s own rules and your organization&apos;s policy. {instructions.length}/12000
              </span>
            </label>
            <Button disabled={busy || !dirty || !editable || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button>
          </form>
        </section>
        {project.status !== "deleted" && <section aria-labelledby="personal-references-heading" className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 id="personal-references-heading" className="text-sm font-semibold">Reference files</h3>
              <p className="text-xs text-muted-foreground">
                Knowledge shared by every chat in this project. Chats can read them but never change them. {references.length} of 100 files, up to 20 MiB each.
              </p>
            </div>
            <Button size="sm" variant="outline" disabled={busy || !editable} onClick={() => upload.current?.click()}>
              <UploadIcon aria-hidden /> Add file
            </Button>
            <input
              ref={upload}
              type="file"
              hidden
              aria-label="Add a reference file"
              onChange={(event) => {
                accept(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <input
              ref={replacer}
              type="file"
              hidden
              aria-label="Choose a replacement file"
              onChange={(event) => {
                accept(event.target.files?.[0], replacing.current);
                event.target.value = "";
              }}
            />
          </div>
          <ul className="divide-y divide-border/70 rounded-md border border-border">
            {references.map((reference) => (
              <li key={reference.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={reference.name}>{reference.name}</span>
                <span className="text-xs text-muted-foreground">{size(reference.sizeBytes)} · v{reference.version}</span>
                <Button size="icon" variant="ghost" aria-label={`Preview ${reference.name}`} title="Preview" disabled={busy} onClick={() => void pickPreview(reference)}><EyeIcon aria-hidden /></Button>
                <Button size="icon" variant="ghost" asChild>
                  <a href={referenceContentUrl(reference)} download={reference.name} aria-label={`Download ${reference.name}`} title="Download"><DownloadIcon aria-hidden /></a>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Replace ${reference.name}`}
                  title="Replace with a new version"
                  disabled={busy || !editable}
                  onClick={() => {
                    replacing.current = reference;
                    replacer.current?.click();
                  }}
                ><UploadIcon aria-hidden /></Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${reference.name}`}
                  title="Remove"
                  disabled={busy || !editable}
                  onClick={() => {
                    if (!window.confirm(`Remove "${reference.name}" from this project?`)) return;
                    void run(async () => {
                      await removeReference(reference);
                      setReferences((previous) => previous.filter((item) => item.id !== reference.id));
                      setPreview((previous) => (previous?.reference.id === reference.id ? null : previous));
                    });
                  }}
                ><Trash2Icon aria-hidden /></Button>
              </li>
            ))}
            {!references.length && <li className="px-3 py-4 text-sm text-muted-foreground">No reference files yet.</li>}
          </ul>
          {preview && (
            <div className="space-y-2 rounded-md border border-border p-3" aria-label={`Preview of ${preview.reference.name}`}>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="truncate">{preview.reference.name}</span>
                <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Close preview</Button>
              </div>
              {preview.text !== undefined ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-5">{preview.text}</pre>
              ) : PAGE_PREVIEW.test(preview.reference.name) ? (
                <div className="h-[28rem]"><DocumentPreview file={asFile(preview.reference)} previewPath={referencePreviewPath(preview.reference)} onStale={() => void load()} /></div>
              ) : null}
              {preview.note && <p className="text-xs text-muted-foreground">{preview.note}</p>}
            </div>
          )}
        </section>}
        <p role="status" aria-live="polite" className="empty:hidden text-xs text-muted-foreground">{notice}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
