"use client";

import type { Team, TeamsResponse, Viewer } from "@lori-enterprise/contracts";
import {
  ArrowRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, Section } from "@/components/ui/section";
import { isAdministrator } from "@/lib/authority";
import { clientApi } from "@/lib/client-api";

function slugFromName(name: string): string {
  const slug = name
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49);
  return slug.length === 1 ? `${slug}-team` : slug;
}

function sortTeams(teams: Team[]): Team[] {
  return [...teams].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.slug.localeCompare(right.slug),
  );
}

export function TeamsManager({
  initialTeams,
  viewer,
}: {
  initialTeams: TeamsResponse;
  viewer: Viewer;
}) {
  const [teams, setTeams] = useState(() => sortTeams(initialTeams.teams));
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Team | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreateOrDelete = isAdministrator(viewer);
  const totalMembers = useMemo(
    () => teams.reduce((total, team) => total + team.memberCount, 0),
    [teams],
  );

  function openCreate() {
    setEditing(null);
    setName("");
    setSlug("");
    setDescription("");
    setSlugTouched(false);
    setError(null);
    setEditorOpen(true);
  }

  function openEdit(team: Team) {
    setEditing(team);
    setName(team.name);
    setSlug(team.slug);
    setDescription(team.description ?? "");
    setSlugTouched(true);
    setError(null);
    setEditorOpen(true);
  }

  function closeEditor() {
    if (pending) return;
    setEditorOpen(false);
    setEditing(null);
    setError(null);
  }

  async function saveTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const team = editing
        ? await clientApi<Team>(
            `/v1/teams/${encodeURIComponent(editing.id)}`,
            {
              body: JSON.stringify({ description, name }),
              method: "PATCH",
            },
          )
        : await clientApi<Team>("/v1/admin/teams", {
            body: JSON.stringify({ description, name, slug }),
            method: "POST",
          });
      setTeams((current) =>
        sortTeams(
          editing
            ? current.map((item) => (item.id === team.id ? team : item))
            : [...current, team],
        ),
      );
      setEditorOpen(false);
      setEditing(null);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The team could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  async function deleteTeam() {
    if (!deleteCandidate) return;
    setPending(true);
    setError(null);
    try {
      await clientApi(`/v1/teams/${encodeURIComponent(deleteCandidate.id)}`, {
        method: "DELETE",
      });
      setTeams((current) =>
        current.filter((team) => team.id !== deleteCandidate.id),
      );
      setDeleteCandidate(null);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The team could not be deleted.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      {error && !editorOpen && !deleteCandidate && (
        <Alert variant="destructive">{error}</Alert>
      )}

      <Dialog
        description={
          editing
            ? "Update the team’s display details. Its URL slug stays fixed."
            : "Create a durable policy scope for a group of organization members."
        }
        onClose={closeEditor}
        open={editorOpen}
        title={editing ? "Edit team" : "Create team"}
      >
        <form className="space-y-4" onSubmit={saveTeam}>
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-1.5">
            <Label className="text-muted-foreground" htmlFor="team-name">
              Team name
            </Label>
            <Input
              autoFocus
              id="team-name"
              maxLength={80}
              onChange={(event) => {
                const value = event.target.value;
                setName(value);
                if (!slugTouched && !editing) setSlug(slugFromName(value));
              }}
              placeholder="Platform engineering"
              required
              value={name}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-muted-foreground" htmlFor="team-slug">
              URL slug
            </Label>
            <Input
              className="font-mono"
              disabled={Boolean(editing)}
              id="team-slug"
              maxLength={49}
              minLength={2}
              onChange={(event) => {
                setSlug(event.target.value.toLocaleLowerCase());
                setSlugTouched(true);
              }}
              pattern="[a-z0-9][a-z0-9-]{1,48}"
              placeholder="platform-engineering"
              required
              value={slug}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Lowercase letters, numbers, and hyphens. This cannot be changed
              after creation.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label
              className="text-muted-foreground"
              htmlFor="team-description"
            >
              Description <span className="font-normal">(optional)</span>
            </Label>
            <Input
              id="team-description"
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Owns shared platform infrastructure and developer tooling."
              value={description}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button
              disabled={pending}
              onClick={closeEditor}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? "Saving…" : editing ? "Save changes" : "Create team"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        description="Members stay in the organization, but this team’s assignments and member-specific overrides will be permanently removed."
        onClose={() => {
          if (!pending) {
            setDeleteCandidate(null);
            setError(null);
          }
        }}
        open={Boolean(deleteCandidate)}
        title={`Delete ${deleteCandidate?.name ?? "team"}?`}
      >
        <div className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <p className="text-sm leading-relaxed text-muted-foreground">
            This action cannot be undone. Connected desktops will refresh
            against the remaining organization and team policies.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={pending}
              onClick={() => setDeleteCandidate(null)}
              type="button"
              variant="outline"
            >
              Keep team
            </Button>
            <Button
              disabled={pending}
              onClick={() => void deleteTeam()}
              type="button"
              variant="destructive"
            >
              <Trash2Icon className="size-4" />
              {pending ? "Deleting…" : "Delete team"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Section
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {teams.length} {teams.length === 1 ? "team" : "teams"}
            </Badge>
            {canCreateOrDelete && (
              <Button onClick={openCreate} size="sm" type="button">
                <PlusIcon className="size-4" />
                New team
              </Button>
            )}
          </div>
        }
        description={
          canCreateOrDelete
            ? `${totalMembers} team memberships across ${viewer.organization.name}. People may belong to more than one team.`
            : "Teams you can administer. Organization administrators control team creation and deletion."
        }
        title="Policy groups"
      >
        <Panel>
          {teams.length === 0 ? (
            <EmptyState
              action={
                canCreateOrDelete ? (
                  <Button onClick={openCreate} size="sm" type="button">
                    <PlusIcon className="size-4" />
                    Create first team
                  </Button>
                ) : undefined
              }
              description={
                canCreateOrDelete
                  ? "Group people around shared catalog access while keeping member exceptions explicit."
                  : "You do not administer a team yet."
              }
              icon={UsersRoundIcon}
              title={canCreateOrDelete ? "Create your first team" : "No managed teams"}
            />
          ) : (
            <ul className="divide-y divide-border">
              {teams.map((team) => (
                <li
                  className="group flex flex-col gap-4 p-4 sm:p-5 md:flex-row md:items-center md:justify-between"
                  key={team.id}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary/60">
                      <UsersRoundIcon
                        aria-hidden
                        className="size-4 text-muted-foreground"
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-words text-sm font-semibold text-foreground sm:truncate">
                          {team.name}
                        </p>
                        <Badge
                          className="max-w-full truncate font-mono"
                          title={`/${team.slug}`}
                          variant="outline"
                        >
                          /{team.slug}
                        </Badge>
                        <Badge variant="secondary">
                          {team.memberCount}{" "}
                          {team.memberCount === 1 ? "member" : "members"}
                        </Badge>
                      </div>
                      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                        {team.description || "No team description yet."}
                      </p>
                    </div>
                  </div>
                  <div className="flex w-full shrink-0 items-center gap-2 md:w-auto">
                    <Button asChild className="flex-1 md:flex-none" size="sm">
                      <Link href={`/teams/${encodeURIComponent(team.slug)}`}>
                        Manage
                        <ArrowRightIcon className="size-3.5" />
                      </Link>
                    </Button>
                    <Button
                      aria-label={`Edit ${team.name}`}
                      onClick={() => openEdit(team)}
                      size="icon"
                      type="button"
                      variant="outline"
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    {canCreateOrDelete && (
                      <Button
                        aria-label={`Delete ${team.name}`}
                        onClick={() => {
                          setError(null);
                          setDeleteCandidate(team);
                        }}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2Icon className="size-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Section>
    </div>
  );
}
