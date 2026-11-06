import type { PersonalProjectCapabilities, ProjectCapabilities } from "@lori-enterprise/contracts";

export type CreationKind = "personal" | "team";

export interface CreationOption {
  kind: CreationKind;
  label: string;
  description: string;
  /** Present when the member may create this kind but cannot right now. */
  disabledReason?: string;
}

/**
 * The kinds of project this member may start, from what the server reports.
 * A kind they have no permission for is absent, never shown disabled; a kind
 * they may create but cannot at the moment (personal limit) stays visible with
 * the reason, so the limit is explained instead of silently hiding the choice.
 */
export function creationOptions(
  team: Pick<ProjectCapabilities, "available" | "canCreate"> | null | undefined,
  personal: Pick<PersonalProjectCapabilities, "available" | "canCreate" | "source" | "count" | "limit"> | null | undefined,
): CreationOption[] {
  const options: CreationOption[] = [];
  if (personal?.available && (personal.canCreate || (personal.source !== "none" && personal.source !== "blocked" && personal.source !== "unavailable"))) {
    options.push({
      kind: "personal",
      label: "Personal project",
      description: "Private to you: chats, instructions and files",
      ...(personal.canCreate ? {} : { disabledReason: `You have ${personal.count} of ${personal.limit} personal projects. Recently deleted projects count until their recovery period ends. Ask an administrator to raise your limit.` }),
    });
  }
  if (team?.available && team.canCreate) {
    options.push({ kind: "team", label: "Team project", description: "Shared with the members and teams you choose" });
  }
  return options;
}
