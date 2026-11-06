"use client";
import { CatalogLogo } from "@/components/catalog-logo";
import { useId, useState } from "react";
import type {
  EnterpriseWorkPolicy,
  PolicyCatalog,
} from "@lori-enterprise/contracts";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Section, SettingsRow } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import type { WorkMode } from "./work-policy-types";

export function WorkDecision({
  label,
  value,
  onChange,
  disabled,
  inherited,
  mode,
}: {
  label: string;
  value: boolean | null;
  onChange(value: boolean | null): void;
  disabled: boolean;
  inherited: boolean;
  mode: WorkMode;
}) {
  return (
    <SelectWrapper className="w-full sm:w-48">
      <Select
        aria-label={label}
        disabled={disabled}
        value={value === null ? "inherit" : value ? "allow" : "deny"}
        onChange={(event) =>
          onChange(
            event.target.value === "inherit"
              ? null
              : event.target.value === "allow",
          )
        }
      >
        <option value="inherit">
          Inherit ({inherited ? "allowed" : "not granted"})
        </option>
        <option value="allow">Allow</option>
        <option value="deny">
          {mode === "member" ? "Block" : "Remove grant"}
        </option>
      </Select>
    </SelectWrapper>
  );
}
export function WorkCatalogDecision({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean | null;
  onChange(value: boolean | null): void;
  disabled: boolean;
}) {
  return (
    <SelectWrapper className="w-full sm:w-48">
      <Select
        aria-label={label}
        disabled={disabled}
        value={value === null ? "inherit" : value ? "allow" : "deny"}
        onChange={(event) =>
          onChange(
            event.target.value === "inherit"
              ? null
              : event.target.value === "allow",
          )
        }
      >
        <option value="inherit">Member choice</option>
        <option value="allow">Assigned</option>
        <option value="deny">Blocked</option>
      </Select>
    </SelectWrapper>
  );
}
export function WorkExtensionAssignments({
  catalog,
  mode,
  disabled,
  inherited,
  effective,
  managedCatalog,
  onCatalog,
}: {
  catalog: PolicyCatalog;
  mode: WorkMode;
  disabled: boolean;
  inherited: EnterpriseWorkPolicy;
  effective: EnterpriseWorkPolicy;
  managedCatalog: EnterpriseWorkPolicy["managedCatalog"];
  onCatalog(
    id: string,
    type: "plugin" | "skill" | "app",
    value: boolean | null,
  ): void;
}) {
  const [tab, setTab] = useState<"plugins" | "skills">("plugins");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const panelId = useId();
  const readOnly = mode === "viewer";
  const override = mode === "member" || mode === "team-member";
  const assignment = (id: string, type: string) =>
    managedCatalog.find((row) => row.id === id && row.type === type)?.enabled ??
    null;
  const inheritedAssignment = (id: string, type: string) =>
    inherited.managedCatalog.some(
      (row) => row.id === id && row.type === type && row.enabled,
    );
  const assigned = (id: string, type: string) =>
    readOnly
      ? effective.managedCatalog.some(
          (row) => row.id === id && row.type === type && row.enabled,
        )
      : (assignment(id, type) ??
        (override ? inheritedAssignment(id, type) : false));
  const all = catalog.items.filter((item) =>
    tab === "skills"
      ? item.type === "skill"
      : item.type === "plugin" || item.type === "app",
  );
  const rows = all.filter(
    (item) =>
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()) &&
      (filter !== "assigned" || assigned(item.id, item.type)),
  );
  return (
    <Section
      title="Work extensions"
      description={
        readOnly
          ? "Your assigned plugins and bundled skills. Plugin accounts are connected individually in Lori desktop."
          : "Assign plugins and bundled skills independently from Code. Each member connects their own plugin account."
      }
    >
      {mode === "organization" ? (
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Member choice follows the member-added settings for plugins and
          skills. Assigned enables an organization resource; Blocked removes
          access from these defaults. Team grants and individual member rules
          can change final access.
        </p>
      ) : null}
      {readOnly && !effective.enabled ? (
        <Alert variant="warning">
          Work is disabled. Saved settings below apply only when access is
          restored.
        </Alert>
      ) : null}
      <div
        className="flex flex-wrap gap-2 border-b border-border"
        role="tablist"
        aria-label="Extension type"
      >
        {(["plugins", "skills"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${panelId}-${id}`}
            aria-controls={panelId}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "plugins"
                    : event.key === "End"
                      ? "skills"
                      : tab === "plugins"
                        ? "skills"
                        : "plugins";
                setTab(next);
                document.getElementById(`${panelId}-${next}`)?.focus();
              }
            }}
            onClick={() => setTab(id)}
            className={`min-h-11 border-b-2 px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {id === "plugins" ? "Plugins" : "Skills"}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-${tab}`}
        className="space-y-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            aria-label="Search Work extensions"
            placeholder={`Search ${tab}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <SelectWrapper className="sm:w-48 sm:shrink-0">
            <Select
              aria-label="Show extensions"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All {tab}</option>
              <option value="assigned">Assigned only</option>
            </Select>
          </SelectWrapper>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {all.filter((item) => assigned(item.id, item.type)).length} assigned ·{" "}
          {all.length} available
        </p>
        <Panel>
          <div className="divide-y divide-border">
            {rows.length ? (
              rows.map((item) => (
                <div key={`${item.type}:${item.id}`}>
                  <SettingsRow
                    icon={<CatalogLogo id={item.id} type={item.type} />}
                    label={item.name}
                    description={item.description}
                  >
                    {readOnly ? (
                      <Badge
                        variant={
                          assigned(item.id, item.type) ? "success" : "secondary"
                        }
                      >
                        {assigned(item.id, item.type)
                          ? "Assigned"
                          : effective.managedCatalog.some(
                                (row) =>
                                  row.id === item.id &&
                                  row.type === item.type &&
                                  !row.enabled,
                              )
                            ? "Blocked"
                            : "Member choice"}
                      </Badge>
                    ) : mode === "organization" ? (
                      <WorkCatalogDecision
                        label={`${item.name} assignment`}
                        value={assignment(item.id, item.type)}
                        disabled={disabled}
                        onChange={(value) =>
                          onCatalog(
                            item.id,
                            item.type as "plugin" | "skill" | "app",
                            value,
                          )
                        }
                      />
                    ) : override ? (
                      <WorkDecision
                        mode={mode}
                        label={`${item.name} assignment`}
                        value={assignment(item.id, item.type)}
                        inherited={inheritedAssignment(item.id, item.type)}
                        disabled={disabled}
                        onChange={(value) =>
                          onCatalog(
                            item.id,
                            item.type as "plugin" | "skill" | "app",
                            value,
                          )
                        }
                      />
                    ) : (
                      <Toggle
                        aria-label={`Assign ${item.name}`}
                        disabled={disabled}
                        checked={assignment(item.id, item.type) === true}
                        onChange={() =>
                          onCatalog(
                            item.id,
                            item.type as "plugin" | "skill" | "app",
                            assignment(item.id, item.type) === true
                              ? null
                              : true,
                          )
                        }
                      />
                    )}
                  </SettingsRow>
                  <details className="px-4 pb-4 sm:px-5">
                    <summary className="w-fit cursor-pointer text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      Setup details for {item.name}
                    </summary>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                      {item.type === "skill"
                        ? "This bundled skill provides task guidance and follows the member’s Work permissions."
                        : "Each member connects their own service account in Lori desktop. Assigning this plugin makes it available; it does not connect an account."}
                    </p>
                    {override ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Inherited assignment:{" "}
                        {inheritedAssignment(item.id, item.type)
                          ? "Assigned"
                          : "Not assigned"}
                        .{" "}
                        {mode === "member"
                          ? "Block overrides organization and team assignments for this member."
                          : "Removing this grant leaves organization and other team assignments in place."}
                      </p>
                    ) : null}
                  </details>
                </div>
              ))
            ) : (
              <div className="space-y-3 p-5">
                <p className="text-sm font-medium">
                  {all.length
                    ? "No extensions match these filters"
                    : `No Work ${tab} available`}
                </p>
                <p className="text-sm text-muted-foreground">
                  {all.length
                    ? "Try another search or show all extensions."
                    : "The current Work catalog has no entries in this category."}
                </p>
                {all.length ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </Section>
  );
}
