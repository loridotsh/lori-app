"use client";

import { useId, useState, type ReactNode } from "react";
import { CheckIcon, UserIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";

export interface Directory {
  members: { id: string; name: string; email: string }[];
  teams: { id: string; name: string }[];
}
export type Subject = { kind: "member" | "team"; subjectId: string };

export const subjectKey = (subject: Subject) => `${subject.kind}:${subject.subjectId}`;
export const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;
export const readableDirectory = (value: unknown): value is Directory =>
  !!value && typeof value === "object" && Array.isArray((value as Directory).members) && Array.isArray((value as Directory).teams);

export function PermissionCard({ title, description, icon, children }: { title: string; description: ReactNode; icon: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card px-5 py-5">
      <header className="mb-5 flex items-start gap-3">
        <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">{icon}</span>
        <div className="min-w-0 space-y-1">
          <h2 id={id} className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border py-5 first:border-t-0 first:pt-0">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function SubjectPicker({
  directory,
  taken,
  label,
  addLabel,
  placeholder,
  members = true,
  teams = true,
  disabled,
  onAdd,
}: {
  directory: Directory;
  taken: ReadonlySet<string>;
  label: string;
  addLabel: string;
  placeholder: string;
  members?: boolean;
  teams?: boolean;
  disabled?: boolean;
  onAdd: (subject: Subject) => void;
}) {
  const [value, setValue] = useState("");
  const options: SearchSelectOption[] = [
    ...(members
      ? directory.members.map((member) => ({
          value: `member:${member.id}`,
          label: member.name,
          description: `${taken.has(`member:${member.id}`) ? "Already added · " : ""}${member.email}`,
          group: "Members",
          disabled: taken.has(`member:${member.id}`),
        }))
      : []),
    ...(teams
      ? directory.teams.map((team) => ({
          value: `team:${team.id}`,
          label: team.name,
          description: taken.has(`team:${team.id}`) ? "Already added" : "Everyone in this team",
          group: "Teams",
          disabled: taken.has(`team:${team.id}`),
        }))
      : []),
  ];
  return (
    <div className="flex items-center gap-2">
      <SearchSelect label={label} placeholder={placeholder} searchPlaceholder={members && teams ? "Search name, email or team…" : "Search name or email…"} value={value} options={options} disabled={disabled} className="min-w-0 flex-1" onChange={setValue} />
      <Button
        type="button"
        variant="outline"
        disabled={!value || disabled}
        onClick={() => {
          const split = value.indexOf(":");
          onAdd({ kind: value.slice(0, split) as Subject["kind"], subjectId: value.slice(split + 1) });
          setValue("");
        }}
      >
        {addLabel}
      </Button>
    </div>
  );
}

function describe(directory: Directory, subject: Subject) {
  if (subject.kind === "member") {
    const member = directory.members.find((item) => item.id === subject.subjectId);
    return member ? { name: member.name, detail: member.email } : { name: "Former member", detail: "No longer in this organization" };
  }
  const team = directory.teams.find((item) => item.id === subject.subjectId);
  return team ? { name: team.name, detail: "Everyone in this team" } : { name: "Former team", detail: "No longer in this organization" };
}

export function SubjectList({
  items,
  directory,
  empty,
  removeLabel = "Remove",
  disabled,
  onRemove,
}: {
  items: Subject[];
  directory: Directory;
  empty: string;
  removeLabel?: string;
  disabled?: boolean;
  onRemove: (subject: Subject) => void;
}) {
  if (!items.length) return <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs leading-5 text-muted-foreground">{empty}</p>;
  return (
    <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border">
      {items.map((item) => {
        const { name, detail } = describe(directory, item);
        return (
          <li key={subjectKey(item)} className="flex min-h-12 items-center gap-3 px-3 py-2">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              {item.kind === "team" ? <UsersIcon className="size-3.5" /> : <UserIcon className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">{detail}</span>
            </span>
            <Button type="button" size="sm" variant="ghost" aria-label={`${removeLabel} ${name}`} disabled={disabled} onClick={() => onRemove(item)}>
              {removeLabel}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function SaveBar({
  dirty,
  busy,
  invalid,
  saved,
  error,
  onSave,
  onDiscard,
  onReload,
}: {
  dirty: boolean;
  busy: boolean;
  invalid?: boolean;
  saved: boolean;
  error: string;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  return (
    <div className="-mx-5 -mb-5 mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-b-lg border-t border-border bg-secondary/40 px-5 py-3">
      <div className="min-w-0 flex-1 text-xs">
        {error ? (
          <p role="alert" className="text-destructive">
            {error}{" "}
            <button type="button" className="rounded underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring" disabled={busy} onClick={onReload}>
              Reload latest
            </button>
          </p>
        ) : (
          <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-muted-foreground">
            {dirty ? (
              "Unsaved changes"
            ) : saved ? (
              <>
                <CheckIcon aria-hidden className="size-3.5 text-success" />
                Saved
              </>
            ) : (
              "No changes"
            )}
          </p>
        )}
      </div>
      <Button type="button" variant="ghost" disabled={!dirty || busy} onClick={onDiscard}>
        Discard
      </Button>
      <Button type="button" disabled={!dirty || busy || invalid} onClick={onSave}>
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
