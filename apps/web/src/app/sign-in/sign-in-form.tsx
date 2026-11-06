"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function SignInForm({
  callbackPath,
  connectingDesktop = false,
  publicSignup = false,
}: {
  callbackPath: string;
  connectingDesktop?: boolean;
  publicSignup?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({
        callbackURL: `${window.location.origin}${callbackPath}`,
        email: String(form.get("email") ?? "").trim().toLowerCase(),
        password: String(form.get("password") ?? ""),
        rememberMe: true,
      });
      if (result.error) {
        throw new Error("The email or password is incorrect.");
      }
      router.replace(callbackPath);
      router.refresh();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Sign in could not be completed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          autoComplete="email"
          id="email"
          name="email"
          placeholder="you@company.com"
          required
          type="email"
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <span className="text-sm text-muted-foreground sm:text-xs">
            Recovery is not enabled
          </span>
        </div>
        <Input
          autoComplete="current-password"
          id="password"
          maxLength={128}
          minLength={12}
          name="password"
          required
          type="password"
        />
      </div>
      <Button className="w-full" disabled={pending} type="submit">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted-foreground sm:text-xs">
        {connectingDesktop
          ? "After sign-in, review the device details and approve the connection once."
          : publicSignup
            ? "Invited to an organization? Open your invitation link."
            : "New members must use the invitation link supplied by an administrator."}
      </p>
      {publicSignup && (
        <p className="text-center text-sm text-muted-foreground sm:text-xs">
          New to Lori?{" "}
          <Link
            className="font-medium text-primary hover:underline"
            href={callbackPath === "/" ? "/sign-up" : `/sign-up?callback=${encodeURIComponent(callbackPath)}`}
          >
            Create an account
          </Link>
        </p>
      )}
    </form>
  );
}
