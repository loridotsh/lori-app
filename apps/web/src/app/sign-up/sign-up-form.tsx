"use client";

import type { CreateWorkspaceInput, Viewer, WorkspaceKind } from "@lori-enterprise/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { AccountTypeFields, OrganizationSlot } from "@/components/account-type-fields";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { clientApi } from "@/lib/client-api";

export function SignUpForm({
  callbackPath,
  initialKind,
}: {
  callbackPath: string;
  initialKind: WorkspaceKind;
}) {
  const router = useRouter();
  const [kind, setKind] = useState(initialKind);
  const [error, setError] = useState<string | null>(null);
  const [existingAccount, setExistingAccount] = useState(false);
  // The account survives a failed workspace step, so a retry must not recreate it.
  const [accountCreated, setAccountCreated] = useState(false);
  const [pending, setPending] = useState(false);
  const signInHref = callbackPath === "/"
    ? "/sign-in"
    : `/sign-in?callback=${encodeURIComponent(callbackPath)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setExistingAccount(false);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (!accountCreated && password !== String(form.get("confirmation") ?? "")) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      if (!accountCreated) {
        const result = await authClient.signUp.email({
          email: String(form.get("email") ?? "").trim().toLowerCase(),
          name: String(form.get("name") ?? "").trim(),
          password,
        });
        if (result.error) {
          if (result.error.code === "USER_ALREADY_EXISTS" || result.error.message?.includes("already")) {
            setExistingAccount(true);
            throw new Error("An account already exists for this email.");
          }
          throw new Error(result.error.message ?? "Your account could not be created.");
        }
        setAccountCreated(true);
      }

      const workspace: CreateWorkspaceInput = kind === "enterprise"
        ? { kind, organizationName: String(form.get("organizationName") ?? "").trim() }
        : { kind };
      await clientApi<Viewer>("/v1/workspaces", {
        body: JSON.stringify(workspace),
        method: "POST",
      });
      router.replace(callbackPath === "/" ? "/welcome?source=signup" : callbackPath);
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Your account could not be created.",
      );
      setPending(false);
    }
  }

  return (
    <form aria-busy={pending} className="space-y-4" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          {error}
          {existingAccount && (
            <>
              {" "}
              <Link className="font-medium underline" href={signInHref}>
                Sign in instead
              </Link>
            </>
          )}
        </Alert>
      )}

      <fieldset className="min-w-0 space-y-4" disabled={pending}>
        <legend className="sr-only">Account details</legend>
        <AccountTypeFields kind={kind} onKindChange={setKind} />
        <OrganizationSlot kind={kind} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input
              autoComplete="name"
              disabled={accountCreated}
              id="name"
              maxLength={100}
              minLength={1}
              name="name"
              placeholder="Alex Morgan"
              required
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              autoComplete="email"
              disabled={accountCreated}
              id="email"
              maxLength={320}
              name="email"
              placeholder="you@example.com"
              required
              type="email"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              aria-describedby="password-help"
              autoComplete="new-password"
              disabled={accountCreated}
              id="password"
              maxLength={128}
              minLength={12}
              name="password"
              required
              type="password"
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="confirmation">Confirm password</Label>
            <Input
              autoComplete="new-password"
              disabled={accountCreated}
              id="confirmation"
              maxLength={128}
              minLength={12}
              name="confirmation"
              required
              type="password"
            />
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground" id="password-help">
          At least 12 characters. Keep it safe: email recovery isn’t available.
        </p>
      </fieldset>

      <Button className="w-full" disabled={pending} type="submit">
        {pending ? "Creating account…" : "Create account"}
      </Button>
      <p className="text-center text-sm text-muted-foreground sm:text-xs">
        Already have an account?{" "}
        <Link className="font-medium text-primary hover:underline" href={signInHref}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
