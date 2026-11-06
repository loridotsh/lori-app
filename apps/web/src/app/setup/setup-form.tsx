"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { ClientApiError, clientApi } from "@/lib/client-api";

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const token = String(form.get("token") ?? "");
    const organizationName = String(form.get("organizationName") ?? "");
    const name = String(form.get("name") ?? "");
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");

    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      await clientApi<{ claimed: true }>("/v1/setup/claim", {
        body: JSON.stringify({ email, token }),
        method: "POST",
      });

      const current = await authClient.getSession();
      if (current.data?.user.email.toLowerCase() !== email) {
        if (current.data) {
          await authClient.signOut();
        }
        const signUp = await authClient.signUp.email({
          callbackURL: `${window.location.origin}/setup`,
          email,
          name,
          password,
        });
        if (signUp.error) {
          const resumed = await authClient.signIn.email({
            callbackURL: `${window.location.origin}/setup`,
            email,
            password,
            rememberMe: true,
          });
          if (resumed.error) {
            throw new Error(
              signUp.error.message ??
                "The administrator account could not be created or resumed.",
            );
          }
        }
      }

      await clientApi("/v1/setup/complete", {
        body: JSON.stringify({ organizationName }),
        method: "POST",
      });
      router.replace("/welcome?source=setup");
      router.refresh();
    } catch (submissionError) {
      if (submissionError instanceof ClientApiError) {
        if (submissionError.code === "setup_token_expired") {
          setError(
            `${submissionError.message} Open “Get your setup token” and follow the renewal steps, then try again.`,
          );
          return;
        }
        if (submissionError.code === "invalid_setup_token") {
          setError(
            `${submissionError.message} Copy the full token from your deployment terminal, without extra spaces.`,
          );
          return;
        }
      }
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Setup could not be completed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={submit} aria-busy={pending}>
      {error && <Alert variant="destructive">{error}</Alert>}

      <fieldset className="min-w-0 space-y-4" disabled={pending}>
        <legend className="sr-only">Organization and Owner details</legend>
        <div className="space-y-1.5">
          <Label htmlFor="token">One-time setup token</Label>
          <Input
            autoComplete="off"
            aria-describedby="token-help"
            spellCheck={false}
            id="token"
            name="token"
            placeholder="Paste the operator token"
            required
            type="password"
          />
          <p id="token-help" className="text-xs leading-5 text-muted-foreground">
            Paste the token from your deployment terminal. Need help? Expand the guide above.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="organizationName">Company name</Label>
          <Input
            autoComplete="organization"
            id="organizationName"
            maxLength={100}
            minLength={2}
            name="organizationName"
            placeholder="Acme"
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input
              autoComplete="name"
              id="name"
              maxLength={100}
              name="name"
              placeholder="Alex Morgan"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Your email</Label>
            <Input
              autoComplete="email"
              id="email"
              maxLength={320}
              name="email"
              placeholder="alex@acme.com"
              required
              type="email"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              autoComplete="new-password"
              aria-describedby="password-help"
              id="password"
              maxLength={128}
              minLength={12}
              name="password"
              required
              type="password"
            />
          </div>
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
        </div>
        <p id="password-help" className="text-xs leading-5 text-muted-foreground">
          Use at least 12 characters. Save your password in a password manager; email recovery is not available.
        </p>
      </fieldset>

      <Button className="h-11 w-full sm:h-11" disabled={pending} type="submit">
        {pending ? "Creating organization…" : "Create organization"}
      </Button>
    </form>
  );
}
