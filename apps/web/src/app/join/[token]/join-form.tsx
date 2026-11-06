"use client";

import type { JoinPreview, Viewer } from "@lori-enterprise/contracts";
import { CheckCircle2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { clientApi } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { announceWorkspaceChange } from "@/lib/workspace-channel";

export function JoinForm({
  cloud = false,
  invitation,
  token,
}: {
  cloud?: boolean;
  invitation: JoinPreview & { state: "pending" };
  token: string;
}) {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [mode, setMode] = useState<"sign-up" | "sign-in">("sign-up");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const sessionEmail = session?.user.email.toLowerCase() ?? null;
  const signedInAsInvitee =
    sessionEmail !== null && sessionEmail === invitation.email?.toLowerCase();
  const signedInAsSomeoneElse = sessionEmail !== null && !signedInAsInvitee;

  /** Someone already signed in as the invitee only has to say yes. */
  async function joinSignedIn() {
    setError(null);
    setPending(true);
    try {
      await clientApi(`/v1/join/${encodeURIComponent(token)}/claim`, {
        body: "{}",
        method: "POST",
      });
      await clientApi<Viewer>(`/v1/join/${encodeURIComponent(token)}/accept`, {
        body: "{}",
        method: "POST",
      });
      announceWorkspaceChange();
      // A full load, so nothing from the previous workspace stays on screen.
      window.location.assign("/welcome?source=invitation");
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The invitation could not be accepted.",
      );
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (mode === "sign-up" && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      await clientApi(`/v1/join/${encodeURIComponent(token)}/claim`, {
        body: "{}",
        method: "POST",
      });

      const existingSession = await authClient.getSession();
      if (
        existingSession.data &&
        existingSession.data.user.email.toLowerCase() !==
          invitation.email?.toLowerCase()
      ) {
        setSignedInAs(existingSession.data.user.email);
        throw new Error(
          `You are signed in as ${existingSession.data.user.email}. Sign out and use ${invitation.email}.`,
        );
      }

      if (!existingSession.data) {
        if (mode === "sign-up") {
          const result = await authClient.signUp.email({
            callbackURL: `${window.location.origin}/join/${token}`,
            email: invitation.email!,
            name: String(form.get("name") ?? ""),
            password,
          });
          if (result.error) {
            const message = result.error.message ?? "Account creation failed.";
            throw new Error(
              message.includes("already")
                ? "An account already exists for this email. Choose \u201cI already have an account.\u201d"
                : message,
            );
          }
        } else {
          const result = await authClient.signIn.email({
            callbackURL: `${window.location.origin}/join/${token}`,
            email: invitation.email!,
            password,
            rememberMe: true,
          });
          if (result.error) {
            throw new Error("The password is incorrect.");
          }
        }
      }

      await clientApi<Viewer>(
        `/v1/join/${encodeURIComponent(token)}/accept`,
        {
          body: "{}",
          method: "POST",
        },
      );
      router.replace("/welcome?source=invitation");
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The invitation could not be accepted.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Invitation summary */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Join {invitation.organizationName}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {invitation.inviterName} invited{" "}
              <span className="break-all font-medium text-foreground">
                {invitation.email}
              </span>
            </p>
          </div>
          <Badge variant="outline" className="capitalize shrink-0">
            {invitation.role}
          </Badge>
        </div>
        <p className="border-t border-border pt-2.5 text-xs text-muted-foreground">
          Expires{" "}
          {/* The viewer's locale formats the time; the server's may differ. */}
          <time dateTime={invitation.expiresAt} suppressHydrationWarning>
            {new Date(invitation.expiresAt!).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </p>
      </div>

      {signedInAsSomeoneElse ? (
        <div className="space-y-4">
          <Alert variant="warning">
            You’re signed in as{" "}
            <span className="font-medium [overflow-wrap:anywhere]">{session?.user.email}</span>
            , but this invitation is for{" "}
            <span className="font-medium [overflow-wrap:anywhere]">{invitation.email}</span>.
          </Alert>
          <Button
            className="w-full"
            onClick={() => {
              void authClient.signOut().then(() => window.location.reload());
            }}
            type="button"
            variant="outline"
          >
            Sign out to continue
          </Button>
        </div>
      ) : signedInAsInvitee && !signedInAs ? (
        <div className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <p className="text-sm text-muted-foreground">
            You’re signed in as{" "}
            <span className="break-all font-medium text-foreground">
              {invitation.email}
            </span>
            .{cloud ? " Your personal workspace stays private and separate." : ""}
          </p>
          <Button
            className="w-full"
            disabled={pending}
            onClick={() => void joinSignedIn()}
            type="button"
          >
            {pending
              ? "Joining organization…"
              : `Join ${invitation.organizationName}`}
          </Button>
        </div>
      ) : (
      <>
      {/* Mode toggle */}
      <div
        aria-label="Account mode"
        className="grid grid-cols-2 gap-0.5 rounded-md border border-border bg-card p-0.5"
        role="group"
      >
        {(["sign-up", "sign-in"] as const).map((value) => (
          <button
            aria-pressed={mode === value}
            className={cn(
              "flex h-11 items-center justify-center rounded text-sm font-medium transition-colors sm:h-9",
              mode === value
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={value}
            onClick={() => setMode(value)}
            type="button"
          >
            {value === "sign-up" ? "Create account" : "I have an account"}
          </button>
        ))}
      </div>

      {cloud && (
        <p className="text-xs leading-5 text-muted-foreground">
          Already use Lori on your own? Choose “I have an account”. You keep
          your personal workspace and can switch between the two.
        </p>
      )}

      <form className="space-y-4" onSubmit={submit}>
        {error && (
          <Alert className="space-y-3" variant="destructive">
            <p>{error}</p>
            {signedInAs && (
              <Button
                onClick={async () => {
                  await authClient.signOut();
                  setSignedInAs(null);
                  setError(null);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Sign out {signedInAs}
              </Button>
            )}
          </Alert>
        )}
        {mode === "sign-up" && (
          <div className="space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input
              autoComplete="name"
              id="name"
              maxLength={100}
              name="name"
              required
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email">Invited email</Label>
          <Input disabled id="email" value={invitation.email} type="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            id="password"
            maxLength={128}
            minLength={12}
            name="password"
            required
            type="password"
          />
        </div>
        {mode === "sign-up" && (
          <div className="space-y-1.5">
            <Label htmlFor="confirmation">Confirm password</Label>
            <Input
              autoComplete="new-password"
              id="confirmation"
              maxLength={128}
              minLength={12}
              name="confirmation"
              required
              type="password"
            />
          </div>
        )}
        <Button className="w-full" disabled={pending} type="submit">
          {pending ? "Joining organization…" : "Join organization"}
        </Button>
      </form>
      </>
      )}
    </div>
  );
}
