"use client";

import type { WorkspaceKind } from "@lori-enterprise/contracts";
import { Building2Icon, LockKeyholeIcon, UserRoundIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const accountTypes = [
  {
    description: "Just for you",
    icon: UserRoundIcon,
    id: "personal",
    label: "Individual",
  },
  {
    description: "For your team",
    icon: Building2Icon,
    id: "enterprise",
    label: "Enterprise",
  },
] as const satisfies ReadonlyArray<{
  description: string;
  icon: typeof UserRoundIcon;
  id: WorkspaceKind;
  label: string;
}>;

export function AccountTypeFields({
  kind,
  onKindChange,
}: {
  kind: WorkspaceKind;
  onKindChange: (kind: WorkspaceKind) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium text-foreground">
        Account type
      </legend>
      <div className="grid grid-cols-2 gap-2">
        {accountTypes.map(({ description, icon: Icon, id, label }) => (
          <label
            className={cn(
              "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40",
              kind === id
                ? "border-primary ring-1 ring-primary"
                : "border-border hover:border-muted-foreground/40",
            )}
            key={id}
          >
            <input
              checked={kind === id}
              className="sr-only"
              name="accountType"
              onChange={() => onKindChange(id)}
              type="radio"
              value={id}
            />
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                kind === id ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {label}
              </span>
              <span className="block text-xs leading-5 text-muted-foreground">
                {description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Only opacity fades. Transitioning visibility leaves a newly shown field
// hidden for a frame, and a quick Tab would skip straight past it.
const slotPanel =
  "col-start-1 row-start-1 min-w-0 transition-opacity duration-150 motion-reduce:transition-none";

/**
 * Both states share one grid cell, so the cell is always as tall as the taller
 * one at any width or text size. Changing account type then swaps content
 * without moving anything else on the page.
 */
export function OrganizationSlot({ kind }: { kind: WorkspaceKind }) {
  const enterprise = kind === "enterprise";
  return (
    <div className="grid">
      <div
        className={cn(slotPanel, enterprise && "invisible opacity-0")}
        inert={enterprise}
      >
        <p className="flex h-full items-center gap-2.5 rounded-md bg-secondary px-3 py-2 text-xs leading-5 text-muted-foreground">
          <LockKeyholeIcon aria-hidden className="size-4 shrink-0" />
          Private to you. You can create or join an organization any time.
        </p>
      </div>
      <div
        className={cn(slotPanel, "space-y-1.5", !enterprise && "invisible opacity-0")}
        inert={!enterprise}
      >
        <OrganizationNameField required={enterprise} />
      </div>
    </div>
  );
}

export function OrganizationNameField({ required = true }: { required?: boolean }) {
  return (
    <>
      <Label htmlFor="organizationName">Organization name</Label>
      <Input
        autoComplete="organization"
        disabled={!required}
        id="organizationName"
        maxLength={100}
        minLength={2}
        name="organizationName"
        placeholder="Acme Inc."
        required={required}
      />
    </>
  );
}
