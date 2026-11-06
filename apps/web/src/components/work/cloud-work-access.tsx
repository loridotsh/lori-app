"use client";

import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useWorkAvailability } from "@/hooks/use-work-availability";

const WORK_OFF = "Work is turned off for your account.";

/**
 * Starts from the server's answer, then follows Work access live, so enabling
 * Work in the editor below enables this entry point without a reload.
 */
export function OpenCloudWorkButton({
  initial,
}: {
  initial: boolean | null;
}) {
  const enabled = useWorkAvailability(false, initial);
  return enabled === false ? (
    <Button variant="outline" disabled aria-disabled="true" title={WORK_OFF}>
      Open Cloud Work
    </Button>
  ) : (
    <Button asChild variant="outline">
      <Link href="/work/cloud">Open Cloud Work</Link>
    </Button>
  );
}

export function CloudWorkOffNotice({
  initial,
  redirected,
  admin,
}: {
  initial: boolean | null;
  /** The member was sent here from Cloud Work. */
  redirected: boolean;
  admin: boolean;
}) {
  const enabled = useWorkAvailability(false, initial);
  // Off for certain, or sent here and not yet known to be on.
  const show = enabled === false || (redirected && enabled === null);
  if (!show) return null;
  return (
    <Alert variant="warning">
      <p className="font-medium">Cloud Work is unavailable</p>
      <p className="mt-0.5 text-sm sm:text-xs">
        {admin
          ? "Work is turned off for your account. Turn it on in Access, or check team and member exceptions that turn it off. Cloud Work becomes available automatically."
          : "Work is turned off for your account. Ask an administrator to turn it on."}
      </p>
    </Alert>
  );
}
