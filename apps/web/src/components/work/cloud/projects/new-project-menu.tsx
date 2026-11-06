"use client";

import { PlusIcon, UserIcon, UsersIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CreationKind, CreationOption } from "./project-creation";

const trigger = "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground";

export const creationIcon = { personal: UserIcon, team: UsersIcon } as const;

/**
 * The single "+" of the Projects list. One available kind starts it directly;
 * several open a small menu; none renders nothing, so a member without
 * permission never sees a control that cannot work.
 */
export function NewProjectMenu({ options, disabled, onChoose }: { options: CreationOption[]; disabled?: boolean; onChoose: (kind: CreationKind) => void }) {
  if (!options.length) return null;
  const only = options.length === 1 && !options[0]!.disabledReason ? options[0]! : null;
  if (only)
    return (
      <button type="button" className={trigger} title={`New ${only.label.toLowerCase()}`} aria-label={`New ${only.label.toLowerCase()}`} disabled={disabled} onClick={() => onChoose(only.kind)}>
        <PlusIcon aria-hidden className="size-4" />
      </button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={trigger} title="New project" aria-label="New project" disabled={disabled}>
          <PlusIcon aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {options.map(option => {
          const Icon = creationIcon[option.kind];
          return (
            <DropdownMenuItem key={option.kind} disabled={!!option.disabledReason} className="items-start gap-2.5 py-2" onSelect={() => onChoose(option.kind)}>
              <Icon aria-hidden className="mt-0.5 text-muted-foreground" />
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span className={cn("text-xs leading-4", option.disabledReason ? "text-destructive" : "text-muted-foreground")}>{option.disabledReason ?? option.description}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
