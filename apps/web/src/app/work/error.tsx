"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function WorkError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-xl space-y-4 px-6 py-16">
      <h1 className="text-xl font-semibold">Work settings couldn’t open</h1>
      <p role="alert" className="text-sm leading-relaxed text-muted-foreground">
        Something interrupted this page. Try opening it again. Unsaved changes
        may need to be re-entered.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Enterprise overview</Link>
        </Button>
      </div>
    </main>
  );
}
