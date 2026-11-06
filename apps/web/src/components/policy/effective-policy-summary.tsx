import type {
  ManagedCatalogItemAttribution,
  OrganizationPolicy,
} from "@lori-enterprise/contracts";
import { CheckIcon, LockKeyholeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Panel, Section } from "@/components/ui/section";

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

export function catalogDecisionDescription(
  attribution: ManagedCatalogItemAttribution,
): string {
  const grants = [
    ...(attribution.organizationAssigned ? ["Organization"] : []),
    ...attribution.teams.map((team) => team.name),
  ];
  if (attribution.source === "member_override") {
    if (attribution.enabled) return "Granted by member override";
    return grants.length > 0
      ? `Blocked by member override; also assigned by ${joinNames(grants)}`
      : "Blocked by member override";
  }
  if (attribution.source === "organization") {
    return attribution.teams.length > 0
      ? `Granted by Organization and ${joinNames(attribution.teams.map((team) => team.name))}`
      : "Granted by Organization";
  }
  return `Granted by ${joinNames(attribution.teams.map((team) => team.name))}`;
}

const personalRows = [
  ["plugins", "Personal apps and plugins"],
  ["providers", "Personal AI providers"],
  ["skills", "Personal skills"],
] as const;

export function EffectivePolicySummary({
  policy,
}: {
  policy: OrganizationPolicy;
}) {
  const attribution = policy.managedCatalogAttribution ?? [];
  return (
    <Section
      description="The final policy after organization grants, every team, team-member exceptions, and global member overrides are resolved."
      title="Final effective access"
    >
      <Panel>
        <div className="divide-y divide-border">
          {personalRows.map(([key, label]) => {
            const allowed = policy.personalInstallations[key];
            return (
              <div
                className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={key}
              >
                <p className="text-sm font-medium text-foreground">{label}</p>
                <Badge variant={allowed ? "default" : "outline"}>
                  {allowed ? (
                    <CheckIcon aria-hidden className="size-3" />
                  ) : (
                    <LockKeyholeIcon aria-hidden className="size-3" />
                  )}
                  {allowed ? "Allowed" : "Restricted"}
                </Badge>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel>
        {attribution.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
            No managed catalog assignments or explicit catalog blocks apply.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {attribution.map((item) => (
              <li
                className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                key={`${item.type}:${item.id}`}
              >
                <div className="min-w-0">
                  <p className="break-words font-mono text-xs font-semibold text-foreground">
                    {item.id}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {catalogDecisionDescription(item)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary">{item.type}</Badge>
                  <Badge variant={item.enabled ? "default" : "outline"}>
                    {item.enabled ? "Assigned" : "Blocked"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Section>
  );
}
