"use client";

import type {
  InvitationRole,
  InviteCreated,
  OwnershipTransferResult,
  PeopleResponse,
  Person,
  Viewer,
} from "@lori-enterprise/contracts";
import {
  ORGANIZATION_ROLE_LABELS,
  ORGANIZATION_ROLE_SUMMARIES,
  membershipChangeDenial,
} from "@lori-enterprise/contracts";
import {
  CheckIcon,
  CopyIcon,
  CrownIcon,
  LinkIcon,
  MailIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, Section } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { authClient } from "@/lib/auth-client";
import { canDo } from "@/lib/authority";
import { ClientApiError, clientApi } from "@/lib/client-api";

function getInitials(name?: string): string {
  if (!name) return "??";
  const parts = name.trim().split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]?.[0] ?? "";
    const last = parts[parts.length - 1]?.[0] ?? "";
    return `${first}${last}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ClientApiError && error.code === "access_revision_conflict")
    return "Roles changed while you were reviewing them. Review the latest list and try again.";
  return error instanceof Error ? error.message : fallback;
}

export function PeopleManager({
  initialPeople,
  publicSignup = false,
  viewer,
}: {
  initialPeople: PeopleResponse;
  publicSignup?: boolean;
  viewer: Viewer;
}) {
  const router = useRouter();
  const [people, setPeople] = useState(initialPeople);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteRole, setInviteRole] = useState<InvitationRole>("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [invitationToRevoke, setInvitationToRevoke] = useState<{
    email: string;
    id: string;
  } | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<{
    memberId: string;
    name: string;
  } | null>(null);
  const [roleChange, setRoleChange] = useState<{
    person: Person;
    role: InvitationRole;
  } | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferConfirm, setTransferConfirm] = useState("");
  const [transferError, setTransferError] = useState<{
    message: string;
    reauthenticate: boolean;
  } | null>(null);

  const isOwner = viewer.role === "owner";
  const canAppointAdmins = canDo(viewer, "admins.manage");
  const canTransfer = canDo(viewer, "ownership.transfer");
  const ownerMissing = viewer.authority?.ownerAssigned === false;

  async function reload() {
    setPeople(await clientApi<PeopleResponse>("/v1/admin/people"));
  }

  async function reloadAfterMutation(successMessage: string) {
    try {
      await reload();
    } catch {
      setPageError(`${successMessage} The list could not be refreshed. Reload the page.`);
    }
    // Server components (navigation, capabilities) follow the new authority.
    router.refresh();
  }

  function denial(person: Person, nextRole: InvitationRole | "remove") {
    return membershipChangeDenial({
      actorRole: viewer.role,
      nextRole,
      self: person.userId === viewer.user.id,
      targetRole: person.role,
    });
  }

  function openInviteDialog() {
    setInviteUrl(null);
    setCopied(false);
    setInviteError(null);
    setInviteRole("member");
    setInviteDialogOpen(true);
  }

  function closeInviteDialog() {
    if (pendingAction === "invite") return;
    setInviteDialogOpen(false);
    setInviteUrl(null);
    setCopied(false);
    setInviteError(null);
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setInviteError(null);
    setPendingAction("invite");
    const form = new FormData(formElement);
    try {
      const created = await clientApi<InviteCreated>("/v1/admin/invitations", {
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          role: canAppointAdmins ? inviteRole : "member",
        }),
        method: "POST",
      });
      setInviteUrl(created.url);
      formElement.reset();
      await reloadAfterMutation("The invitation was created, but");
    } catch (inviteError) {
      setInviteError(
        inviteError instanceof Error
          ? inviteError.message
          : "The invitation could not be created.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setInviteError(
        "Clipboard access failed. Select and copy the link manually.",
      );
    }
  }

  async function regenerate(id: string) {
    setPageError(null);
    setPendingAction(id);
    try {
      const created = await clientApi<InviteCreated>(
        `/v1/admin/invitations/${id}/regenerate`,
        { body: "{}", method: "POST" },
      );
      setInviteUrl(created.url);
      setCopied(false);
      setInviteDialogOpen(true);
      await reloadAfterMutation("The invitation link was regenerated, but");
    } catch (regenerationError) {
      setPageError(
        regenerationError instanceof Error
          ? regenerationError.message
          : "A new link could not be generated.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function revoke() {
    if (!invitationToRevoke) return;
    setPageError(null);
    setPendingAction(invitationToRevoke.id);
    try {
      await clientApi(`/v1/admin/invitations/${invitationToRevoke.id}`, {
        method: "DELETE",
      });
      setInvitationToRevoke(null);
      await reloadAfterMutation("The invitation was revoked, but");
    } catch (revokeError) {
      setPageError(
        revokeError instanceof Error
          ? revokeError.message
          : "The invitation could not be revoked.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function changeRole() {
    if (!roleChange) return;
    const { person, role } = roleChange;
    setPageError(null);
    setPendingAction(person.memberId);
    try {
      await clientApi(`/v1/admin/members/${person.memberId}`, {
        body: JSON.stringify({
          role,
          ...(people.revision ? { expectedRevision: people.revision } : {}),
        }),
        method: "PATCH",
      });
      setRoleChange(null);
      await reloadAfterMutation("The member role was changed, but");
    } catch (roleError) {
      setPageError(failureMessage(roleError, "The member role could not be changed."));
      if (roleError instanceof ClientApiError && roleError.code === "access_revision_conflict") {
        // The reviewed change no longer matches the list; start over from the latest roles.
        setRoleChange(null);
        await reload().catch(() => undefined);
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function remove() {
    if (!memberToRemove) return;
    setPageError(null);
    setPendingAction(memberToRemove.memberId);
    try {
      await clientApi(
        `/v1/admin/members/${memberToRemove.memberId}${people.revision ? `?expectedRevision=${people.revision}` : ""}`,
        { method: "DELETE" },
      );
      setMemberToRemove(null);
      await reloadAfterMutation("The member was removed, but");
    } catch (removeError) {
      setPageError(failureMessage(removeError, "The member could not be removed."));
      if (removeError instanceof ClientApiError && removeError.code === "access_revision_conflict") {
        setMemberToRemove(null);
        await reload().catch(() => undefined);
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function signInAgain() {
    try {
      await authClient.signOut();
    } catch {
      // A failed sign-out still leaves for sign-in; the stale session is rejected there.
    }
    router.replace("/sign-in?callback=%2Fpeople");
    router.refresh();
  }

  const transferCandidate = people.members.find(
    (person) => person.memberId === transferTarget,
  );

  function closeTransfer() {
    if (pendingAction === "transfer") return;
    setTransferOpen(false);
    setTransferTarget("");
    setTransferConfirm("");
    setTransferError(null);
  }

  async function transfer() {
    if (!transferCandidate || !people.revision) return;
    setTransferError(null);
    setPendingAction("transfer");
    try {
      await clientApi<OwnershipTransferResult>("/v1/admin/ownership-transfer", {
        body: JSON.stringify({
          expectedRevision: people.revision,
          memberId: transferCandidate.memberId,
        }),
        method: "POST",
      });
      setTransferOpen(false);
      setTransferTarget("");
      setTransferConfirm("");
      await reloadAfterMutation("Ownership was transferred, but");
    } catch (error) {
      const reauthenticate =
        error instanceof ClientApiError && error.code === "session_not_fresh";
      setTransferError({
        message: failureMessage(error, "Ownership could not be transferred."),
        reauthenticate,
      });
      if (error instanceof ClientApiError && error.code === "access_revision_conflict")
        await reload().catch(() => undefined);
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-8">
      {ownerMissing && (
        <Alert variant="warning">
          This organization has no owner, so administrators cannot be
          appointed, changed, or removed. A server operator can assign an
          existing administrator as owner with the <code>owner-assign</code>{" "}
          tool.
        </Alert>
      )}
      {pageError && !invitationToRevoke && !memberToRemove && !roleChange && (
        <Alert variant="destructive">{pageError}</Alert>
      )}

      <Dialog
        description="The link will stop working immediately. You can create a new invitation for this email later."
        onClose={() => {
          if (!pendingAction) {
            setInvitationToRevoke(null);
            setPageError(null);
          }
        }}
        open={Boolean(invitationToRevoke)}
        title="Revoke invitation?"
      >
        <div className="space-y-4">
          {pageError && <Alert variant="destructive">{pageError}</Alert>}
          <p className="break-all text-sm font-medium text-foreground">
            {invitationToRevoke?.email}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={Boolean(pendingAction)}
              onClick={() => {
                setInvitationToRevoke(null);
                setPageError(null);
              }}
              type="button"
              variant="outline"
            >
              Keep invitation
            </Button>
            <Button
              disabled={Boolean(pendingAction)}
              onClick={() => void revoke()}
              type="button"
              variant="destructive"
            >
              <Trash2Icon />
              {pendingAction ? "Revoking…" : "Revoke invitation"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        description="Organization access, active sessions, device credentials, team memberships, and shared-project access for this person will be revoked. Work they started stops, and invitations they sent are cancelled."
        onClose={() => {
          // As above: a programmatic close after a conflict keeps its message.
          if (!pendingAction && memberToRemove) {
            setMemberToRemove(null);
            setPageError(null);
          }
        }}
        open={Boolean(memberToRemove)}
        title={`Remove ${memberToRemove?.name ?? "member"}?`}
      >
        <div className="space-y-4">
          {pageError && <Alert variant="destructive">{pageError}</Alert>}
          <p className="text-sm leading-relaxed text-muted-foreground">
            Their private chats, memory and personal projects here are
            permanently deleted. This does not delete data already stored on
            their computer. This action cannot be undone from the dashboard.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={Boolean(pendingAction)}
              onClick={() => {
                setMemberToRemove(null);
                setPageError(null);
              }}
              type="button"
              variant="outline"
            >
              Keep member
            </Button>
            <Button
              disabled={Boolean(pendingAction)}
              onClick={() => void remove()}
              type="button"
              variant="destructive"
            >
              <Trash2Icon />
              {pendingAction ? "Removing…" : "Remove member"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        description={
          roleChange
            ? `${roleChange.person.name} becomes ${roleChange.role === "admin" ? "an admin" : "a member"}.`
            : undefined
        }
        onClose={() => {
          // Only a dismissal by the person clears the message; when the page
          // closes the dialog itself (roles changed elsewhere), keep it.
          if (!pendingAction && roleChange) {
            setRoleChange(null);
            setPageError(null);
          }
        }}
        open={Boolean(roleChange)}
        title="Change organization role?"
      >
        {roleChange && (
          <div className="space-y-4">
            {pageError && <Alert variant="destructive">{pageError}</Alert>}
            <div className="space-y-1.5 rounded-md border border-border p-3 text-sm">
              <p className="font-medium text-foreground">
                {ORGANIZATION_ROLE_LABELS[roleChange.role]}
              </p>
              <p className="leading-relaxed text-muted-foreground">
                {ORGANIZATION_ROLE_SUMMARIES[roleChange.role]}
              </p>
            </div>
            {roleChange.role === "member" && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Organization administration and shared projects they reach only
                as an admin are withdrawn right away. Team, project, and Work
                assignments made to them stay in place.
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                disabled={Boolean(pendingAction)}
                onClick={() => {
                  setRoleChange(null);
                  setPageError(null);
                }}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={Boolean(pendingAction)}
                onClick={() => void changeRole()}
                type="button"
              >
                {pendingAction ? "Saving…" : `Make ${ORGANIZATION_ROLE_LABELS[roleChange.role].toLowerCase()}`}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        description="The new owner gets every administrator capability plus appointing admins and transferring ownership. You become an admin."
        onClose={closeTransfer}
        open={transferOpen}
        title="Transfer ownership"
      >
        <div className="space-y-4">
          {transferError && (
            <Alert variant="destructive">
              {transferError.message}
              {transferError.reauthenticate && (
                <>
                  {" "}
                  <button
                    className="font-medium underline"
                    onClick={() => void signInAgain()}
                    type="button"
                  >
                    Sign in again
                  </button>
                </>
              )}
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label className="text-muted-foreground" htmlFor="transfer-target">
              New owner
            </Label>
            <SelectWrapper>
              <Select
                id="transfer-target"
                onChange={(event) => {
                  setTransferTarget(event.target.value);
                  setTransferConfirm("");
                }}
                value={transferTarget}
              >
                <option value="">Choose a member</option>
                {people.members
                  .filter((person) => person.userId !== viewer.user.id)
                  .map((person) => (
                    <option key={person.memberId} value={person.memberId}>
                      {person.name} ({person.email})
                    </option>
                  ))}
              </Select>
            </SelectWrapper>
          </div>
          {transferCandidate && (
            <div className="space-y-1.5">
              <Label className="text-muted-foreground" htmlFor="transfer-confirm">
                Type {transferCandidate.email} to confirm
              </Label>
              <Input
                autoComplete="off"
                id="transfer-confirm"
                onChange={(event) => setTransferConfirm(event.target.value)}
                value={transferConfirm}
              />
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            For security, this requires a sign-in within the last 15 minutes.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={pendingAction === "transfer"}
              onClick={closeTransfer}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                pendingAction === "transfer" ||
                !transferCandidate ||
                transferConfirm.trim().toLowerCase() !==
                  transferCandidate.email.toLowerCase()
              }
              onClick={() => void transfer()}
              type="button"
            >
              <CrownIcon className="size-4" />
              {pendingAction === "transfer" ? "Transferring…" : "Transfer ownership"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        description={
          inviteUrl
            ? publicSignup
              ? "Send this only to the person you invited: anyone who has the link can use it to join. It expires in 7 days and is shown once."
              : "Share this link securely. It expires in 7 days and is shown once."
            : publicSignup
              ? "Generate an email-bound invitation link valid for 7 days. It works for new people and for anyone already using Lori on their own, who keep their personal workspace."
              : "Generate an email-bound invitation link valid for 7 days."
        }
        onClose={closeInviteDialog}
        open={inviteDialogOpen}
        title={inviteUrl ? "Invitation link ready" : "Invite member"}
      >
        {inviteUrl ? (
          <div className="space-y-4">
            {inviteError && (
              <Alert className="text-xs" variant="destructive">
                {inviteError}
              </Alert>
            )}
            <div className="space-y-2">
              <Label className="text-muted-foreground" htmlFor="invite-url">
                Invitation link
              </Label>
              <Input
                aria-label="Generated invitation URL"
                className="font-mono text-sm"
                id="invite-url"
                readOnly
                value={inviteUrl}
              />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button onClick={closeInviteDialog} type="button" variant="outline">
                Done
              </Button>
              <Button onClick={() => void copyLink()} type="button">
                {copied ? (
                  <CheckIcon className="size-4 text-success" />
                ) : (
                  <CopyIcon className="size-4" />
                )}
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={invite}>
            {inviteError && (
              <Alert
                className="text-xs"
                id="invite-error"
                variant="destructive"
              >
                {inviteError}
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label className="text-muted-foreground" htmlFor="invite-email">
                Email address
              </Label>
              <Input
                aria-describedby={inviteError ? "invite-error" : undefined}
                aria-invalid={inviteError ? true : undefined}
                autoFocus
                className={inviteError ? "border-destructive/50" : undefined}
                id="invite-email"
                name="email"
                onInput={() => setInviteError(null)}
                placeholder="person@company.com"
                required
                type="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground" htmlFor="invite-role">
                Role
              </Label>
              <SelectWrapper>
                <Select
                  aria-describedby="invite-role-summary"
                  disabled={!canAppointAdmins}
                  id="invite-role"
                  name="role"
                  onChange={(event) =>
                    setInviteRole(event.target.value as InvitationRole)
                  }
                  value={canAppointAdmins ? inviteRole : "member"}
                >
                  <option value="member">Member</option>
                  {canAppointAdmins && <option value="admin">Admin</option>}
                </Select>
              </SelectWrapper>
              <p
                className="text-xs leading-relaxed text-muted-foreground"
                id="invite-role-summary"
              >
                {ORGANIZATION_ROLE_SUMMARIES[canAppointAdmins ? inviteRole : "member"]}
                {!canAppointAdmins &&
                  " Only the organization owner can invite admins."}
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                disabled={pendingAction === "invite"}
                onClick={closeInviteDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={pendingAction === "invite"} type="submit">
                <UserPlusIcon className="size-4" />
                {pendingAction === "invite" ? "Creating…" : "Create invite"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Section
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {people.members.length}{" "}
              {people.members.length === 1 ? "member" : "members"}
            </Badge>
            {canTransfer && (
              <Button
                onClick={() => {
                  setTransferError(null);
                  setTransferOpen(true);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <CrownIcon className="size-4" />
                Transfer ownership
              </Button>
            )}
            <Button onClick={openInviteDialog} size="sm" type="button">
              <UserPlusIcon className="size-4" />
              Invite member
            </Button>
          </div>
        }
        description={
          isOwner
            ? `Active accounts in ${viewer.organization.name}. As the owner, you appoint and remove admins.`
            : `Active accounts in ${viewer.organization.name}. Only the owner can appoint, change, or remove admins.`
        }
        title="Members"
      >
        <Panel>
          <ul className="divide-y divide-border">
            {people.members.map((person) => {
              const isSelf = person.userId === viewer.user.id;
              const roleEditable =
                denial(person, person.role === "admin" ? "member" : "admin") === null;
              const removable = denial(person, "remove") === null;
              return (
                <li
                  className="flex flex-col gap-3 p-4 sm:p-5 md:flex-row md:items-center md:justify-between"
                  key={person.memberId}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-foreground">
                      {getInitials(person.name)}
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-words text-sm font-medium text-foreground sm:truncate">
                          {person.name}
                        </p>
                        {isSelf && (
                          <Badge variant="outline">
                            You
                          </Badge>
                        )}
                        <Badge
                          variant={person.role === "member" ? "secondary" : "default"}
                        >
                          {ORGANIZATION_ROLE_LABELS[person.role]}
                        </Badge>
                      </div>
                      <p className="break-all text-sm text-muted-foreground sm:truncate sm:text-xs">
                        {person.email}
                      </p>
                    </div>
                  </div>

                  <div className="flex w-full shrink-0 items-center gap-2 md:w-auto">
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/people/${encodeURIComponent(person.memberId)}`}
                      >
                        <SlidersHorizontalIcon className="size-3.5" />
                        Access
                      </Link>
                    </Button>
                    {roleEditable ? (
                      <SelectWrapper className="w-28">
                        <Select
                          aria-label={`Role for ${person.name}`}
                          className="sm:h-8 sm:text-xs"
                          disabled={pendingAction === person.memberId}
                          onChange={(event) => {
                            const role = event.target.value as InvitationRole;
                            if (role !== person.role) {
                              setPageError(null);
                              setRoleChange({ person, role });
                            }
                          }}
                          value={person.role}
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </Select>
                      </SelectWrapper>
                    ) : null}
                    <Button
                      aria-label={`Remove ${person.name}`}
                      className="text-muted-foreground hover:text-destructive"
                      disabled={!removable || pendingAction === person.memberId}
                      onClick={() => {
                        setPageError(null);
                        setMemberToRemove({
                          memberId: person.memberId,
                          name: person.name,
                        });
                      }}
                      size="icon"
                      title={
                        removable
                          ? undefined
                          : person.role === "owner"
                            ? "Transfer ownership before removing the owner"
                            : isSelf
                              ? "You cannot remove yourself"
                              : "Only the owner can remove admins"
                      }
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      </Section>

      <Section
        description="Outstanding email invitations waiting to be claimed."
        title="Pending invitations"
      >
        <Panel>
          {people.invitations.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={openInviteDialog} size="sm" type="button">
                  <UserPlusIcon className="size-4" />
                  Invite member
                </Button>
              }
              description="Send an invitation link to add someone to your organization."
              icon={MailIcon}
              title="No pending invitations"
            />
          ) : (
            <ul className="divide-y divide-border">
              {people.invitations.map((invitation) => {
                const manageable =
                  invitation.role !== "admin" || canAppointAdmins;
                return (
                  <li
                    className="flex flex-col gap-3 p-4 sm:p-5 md:flex-row md:items-center md:justify-between"
                    key={invitation.id}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-all text-sm font-medium text-foreground sm:truncate">
                          {invitation.email}
                        </p>
                        <Badge variant="outline">
                          {ORGANIZATION_ROLE_LABELS[invitation.role]}
                        </Badge>
                        <Badge
                          className="capitalize"
                          variant={
                            invitation.state === "pending" ? "warning" : "outline"
                          }
                        >
                          {invitation.state}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Invited by {invitation.invitedByName} · Expires{" "}
                        {/* The viewer's locale and time zone format the date; the server's may differ. */}
                        <time dateTime={invitation.expiresAt} suppressHydrationWarning>
                          {new Date(invitation.expiresAt).toLocaleDateString()}
                        </time>
                        {!manageable && " · Only the owner can manage admin invitations"}
                      </p>
                    </div>
                    {manageable && (
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          disabled={pendingAction === invitation.id}
                          onClick={() => void regenerate(invitation.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {invitation.state === "pending" ? (
                            <RotateCwIcon className="size-3.5" />
                          ) : (
                            <LinkIcon className="size-3.5" />
                          )}
                          New link
                        </Button>
                        {invitation.state === "pending" && (
                          <Button
                            className="text-destructive hover:text-destructive"
                            disabled={pendingAction === invitation.id}
                            onClick={() => {
                              setPageError(null);
                              setInvitationToRevoke({
                                email: invitation.email,
                                id: invitation.id,
                              });
                            }}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </Section>
    </div>
  );
}
