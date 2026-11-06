"use client";

import type {
  EligibleTeamMembersResponse,
  BulkTeamMembersResponse,
  Team,
  TeamMember,
  TeamMembersResponse,
  TeamRole,
  Viewer,
} from "@lori-enterprise/contracts";
import {
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UserRoundCheckIcon,
} from "lucide-react";
import Link from "next/link";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, Section } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { Select, SelectWrapper } from "@/components/ui/select";
import { isAdministrator } from "@/lib/authority";
import { clientApi } from "@/lib/client-api";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function TeamMembersManager({
  initialEligible,
  initialMembers,
  team,
  viewer,
}: {
  initialEligible: EligibleTeamMembersResponse;
  initialMembers: TeamMembersResponse;
  team: Team;
  viewer: Viewer;
}) {
  const administrator = isAdministrator(viewer);
  const [members, setMembers] = useState(initialMembers.members);
  const [eligible, setEligible] = useState(initialEligible.members);
  const [eligiblePageInfo, setEligiblePageInfo] = useState(
    initialEligible.pageInfo,
  );
  const [memberPageInfo, setMemberPageInfo] = useState(initialMembers.pageInfo);
  const [addOpen, setAddOpen] = useState(false);
  const [removeCandidate, setRemoveCandidate] = useState<TeamMember | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eligibleQuery, setEligibleQuery] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const eligibleRequest = useRef(0);

  useEffect(() => {
    const requestId = ++eligibleRequest.current;
    if (!addOpen) {
      setEligibleLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setEligibleLoading(true);
      clientApi<EligibleTeamMembersResponse>(
        `/v1/teams/${encodeURIComponent(team.id)}/eligible-members?q=${encodeURIComponent(eligibleQuery.trim())}&limit=50&offset=0`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (eligibleRequest.current !== requestId) return;
          setEligible(result.members);
          setEligiblePageInfo(result.pageInfo);
          setSelectedMemberIds((current) =>
            new Set(
              [...current].filter((memberId) =>
                result.members.some((person) => person.memberId === memberId),
              ),
            ),
          );
        })
        .catch((requestError) => {
          if (
            eligibleRequest.current !== requestId ||
            (requestError instanceof DOMException && requestError.name === "AbortError")
          ) {
            return;
          }
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Eligible members could not be loaded.",
          );
        })
        .finally(() => {
          if (eligibleRequest.current === requestId) {
            setEligibleLoading(false);
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [addOpen, eligibleQuery, team.id]);

  async function reload() {
    const [membersResult, eligibleResult] = await Promise.all([
      clientApi<TeamMembersResponse>(
        `/v1/teams/${encodeURIComponent(team.id)}/members`,
      ),
      clientApi<EligibleTeamMembersResponse>(
        `/v1/teams/${encodeURIComponent(team.id)}/eligible-members`,
      ),
    ]);
    setMembers(membersResult.members);
    setEligible(eligibleResult.members);
    setMemberPageInfo(membersResult.pageInfo);
    setEligiblePageInfo(eligibleResult.pageInfo);
  }

  async function reloadAfterMutation(successMessage: string) {
    try {
      await reload();
    } catch {
      setError(`${successMessage} The list could not be refreshed. Reload the page.`);
    }
  }

  async function loadMoreMembers() {
    if (!memberPageInfo?.hasMore) return;
    setPendingAction("load-members");
    setError(null);
    try {
      const next = await clientApi<TeamMembersResponse>(
        `/v1/teams/${encodeURIComponent(team.id)}/members?limit=${memberPageInfo.limit}&offset=${memberPageInfo.offset + memberPageInfo.limit}`,
      );
      setMembers((current) => [
        ...current,
        ...next.members.filter(
          (candidate) =>
            !current.some(
              (member) => member.teamMemberId === candidate.teamMemberId,
            ),
        ),
      ]);
      setMemberPageInfo(next.pageInfo);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "More team members could not be loaded.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const role = String(form.get("role") ?? "member") as TeamRole;
    const memberIds = [...selectedMemberIds];
    if (memberIds.length === 0) {
      setError("Select at least one organization member.");
      return;
    }
    setPendingAction("add");
    setError(null);
    try {
      await clientApi<BulkTeamMembersResponse>(
        `/v1/teams/${encodeURIComponent(team.id)}/members/bulk`,
        {
          body: JSON.stringify({ memberIds, role }),
          method: "POST",
        },
      );
      setAddOpen(false);
      setSelectedMemberIds(new Set());
      setEligibleQuery("");
      await reloadAfterMutation("The member change was saved, but");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The member could not be added.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function changeRole(teamMemberId: string, role: TeamRole) {
    setPendingAction(teamMemberId);
    setError(null);
    try {
      const updated = await clientApi<TeamMember>(
        `/v1/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(teamMemberId)}`,
        {
          body: JSON.stringify({ role }),
          method: "PATCH",
        },
      );
      setMembers((current) =>
        current.map((member) =>
          member.teamMemberId === updated.teamMemberId ? updated : member,
        ),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The team role could not be changed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function removeMember() {
    if (!removeCandidate) return;
    setPendingAction(removeCandidate.teamMemberId);
    setError(null);
    try {
      await clientApi(
        `/v1/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(removeCandidate.teamMemberId)}`,
        { method: "DELETE" },
      );
      setRemoveCandidate(null);
      await reloadAfterMutation("The member was removed, but");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The member could not be removed from the team.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <Section
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {memberPageInfo?.total ?? members.length}{" "}
            {(memberPageInfo?.total ?? members.length) === 1 ? "member" : "members"}
          </Badge>
          <Button
            disabled={eligible.length === 0}
            onClick={() => {
              setError(null);
              setSelectedMemberIds(new Set());
              setEligibleQuery("");
              setAddOpen(true);
            }}
            size="sm"
            type="button"
          >
            <PlusIcon className="size-4" />
            Add member
          </Button>
        </div>
      }
      description="Members may belong to several teams. Team administrators can manage this team only."
      title="Members"
    >
      {error && !addOpen && !removeCandidate && (
        <Alert variant="destructive">{error}</Alert>
      )}

      <Dialog
        description="Search and select organization members, then add them in one policy update."
        onClose={() => {
          if (!pendingAction) {
            setAddOpen(false);
            setError(null);
          }
        }}
        open={addOpen}
        title={`Add member to ${team.name}`}
      >
        <form className="space-y-4" onSubmit={addMember}>
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <label
              className="text-sm font-medium text-muted-foreground sm:text-xs"
              htmlFor="team-member-search"
            >
              Organization members
            </label>
            <div className="relative">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="pl-8"
                id="team-member-search"
                onChange={(event) => setEligibleQuery(event.target.value)}
                placeholder="Search by name or email…"
                value={eligibleQuery}
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {eligibleLoading ? (
                <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                  Searching organization members…
                </p>
              ) : eligible.length === 0 ? (
                <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                  No eligible members match this search.
                </p>
              ) : eligible.map((person) => (
                  <label
                    className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2.5 transition-colors last:border-b-0 hover:bg-secondary/50"
                    key={person.memberId}
                  >
                    <input
                      aria-label={`${person.name} — ${person.email}`}
                      checked={selectedMemberIds.has(person.memberId)}
                      className="mt-0.5 size-4 accent-primary"
                      onChange={(event) => {
                        setSelectedMemberIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(person.memberId);
                          else next.delete(person.memberId);
                          return next;
                        });
                      }}
                      type="checkbox"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {person.name}
                      </span>
                      <span className="block break-all text-sm text-muted-foreground sm:truncate sm:text-xs">
                        {person.email}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedMemberIds.size} selected. Up to 100 people can be added at once.
              {eligiblePageInfo?.hasMore
                ? " Refine the search to find people beyond the first 50 results."
                : ""}
            </p>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-muted-foreground sm:text-xs"
              htmlFor="team-member-role"
            >
              Team role
            </label>
            <SelectWrapper>
              <Select
                defaultValue="member"
                id="team-member-role"
                name="role"
              >
                <option value="member">Member</option>
                {administrator && (
                  <option value="team_admin">Team admin</option>
                )}
              </Select>
            </SelectWrapper>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Only organization administrators can grant team administrator access.
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button
              disabled={pendingAction === "add"}
              onClick={() => setAddOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={pendingAction === "add" || selectedMemberIds.size === 0}
              type="submit"
            >
              {pendingAction === "add"
                ? "Adding…"
                : selectedMemberIds.size === 1
                  ? "Add member"
                  : `Add ${selectedMemberIds.size} members`}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        description="The person stays in the organization. Their overrides for this team will be removed."
        onClose={() => {
          if (!pendingAction) {
            setRemoveCandidate(null);
            setError(null);
          }
        }}
        open={Boolean(removeCandidate)}
        title={`Remove ${removeCandidate?.name ?? "member"}?`}
      >
        <div className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <p className="text-sm leading-relaxed text-muted-foreground">
            They lose the access and shared projects granted through this team.
            Access from the organization, other teams, or direct project
            assignments is unchanged.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={Boolean(pendingAction)}
              onClick={() => setRemoveCandidate(null)}
              type="button"
              variant="outline"
            >
              Keep member
            </Button>
            <Button
              disabled={Boolean(pendingAction)}
              onClick={() => void removeMember()}
              type="button"
              variant="destructive"
            >
              <Trash2Icon className="size-4" />
              {pendingAction ? "Removing…" : "Remove from team"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Panel>
        {members.length === 0 ? (
          <EmptyState
            action={
              eligible.length > 0 ? (
                <Button onClick={() => setAddOpen(true)} size="sm" type="button">
                  <PlusIcon className="size-4" />
                  Add first member
                </Button>
              ) : undefined
            }
            description="Add organization members to start applying this team’s access policy."
            icon={UserRoundCheckIcon}
            title="No team members yet"
          />
        ) : (
          <ul className="divide-y divide-border">
            {members.map((member) => (
              <li
                className="flex flex-col gap-3 p-4 sm:p-5 md:flex-row md:items-center md:justify-between"
                key={member.teamMemberId}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-foreground">
                    {getInitials(member.name)}
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="break-words text-sm font-medium text-foreground sm:truncate">
                        {member.name}
                      </p>
                      <Badge
                        variant={
                          member.role === "team_admin" ? "default" : "secondary"
                        }
                      >
                        {member.role === "team_admin" ? "Team admin" : "Member"}
                      </Badge>
                    </div>
                    <p className="break-all text-sm text-muted-foreground sm:truncate sm:text-xs">
                      {member.email}
                    </p>
                  </div>
                </div>
                <div className="flex w-full shrink-0 items-center gap-2 md:w-auto">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/teams/${encodeURIComponent(team.slug)}/members/${encodeURIComponent(member.memberId)}`}
                    >
                      <SlidersHorizontalIcon className="size-3.5" />
                      Overrides
                    </Link>
                  </Button>
                  {administrator ? (
                    <SelectWrapper className="w-32">
                      <Select
                        aria-label={`Team role for ${member.name}`}
                        className="sm:h-8 sm:text-xs"
                        disabled={pendingAction === member.teamMemberId}
                        onChange={(event) =>
                          void changeRole(
                            member.teamMemberId,
                            event.target.value as TeamRole,
                          )
                        }
                        value={member.role}
                      >
                        <option value="member">Member</option>
                        <option value="team_admin">Team admin</option>
                      </Select>
                    </SelectWrapper>
                  ) : (
                    <Badge variant="outline">
                      {member.role === "team_admin" ? "Team admin" : "Member"}
                    </Badge>
                  )}
                  <Button
                    aria-label={`Remove ${member.name} from ${team.name}`}
                    disabled={
                      pendingAction === member.teamMemberId ||
                      (!administrator && member.role === "team_admin")
                    }
                    onClick={() => {
                      setError(null);
                      setRemoveCandidate(member);
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {memberPageInfo?.hasMore && (
          <div className="flex justify-center border-t border-border p-3">
            <Button
              disabled={pendingAction === "load-members"}
              onClick={() => void loadMoreMembers()}
              size="sm"
              type="button"
              variant="outline"
            >
              {pendingAction === "load-members" ? "Loading…" : "Load more members"}
            </Button>
          </div>
        )}
      </Panel>
    </Section>
  );
}
