"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  desktopConnectUrl,
  desktopLaunchGuidance,
  usesDevelopmentDesktopHandoff,
} from "@/lib/desktop-connect";
import { cn } from "@/lib/utils";

export function OpenLoriControl({
  className,
  label = "Open Lori desktop",
  publicUrl,
  showHelp = true,
  variant = "default",
}: {
  className?: string;
  label?: string;
  publicUrl: string;
  showHelp?: boolean;
  variant?: "default" | "outline";
}) {
  const development = usesDevelopmentDesktopHandoff(publicUrl);
  const connectUrl = desktopConnectUrl(publicUrl, development);
  const packagedAppUrl = development
    ? desktopConnectUrl(publicUrl, false)
    : null;
  const [attempted, setAttempted] = useState(false);

  if (!connectUrl) {
    return (
      <Alert className={className} variant="destructive">
        Lori cannot be opened because this deployment does not expose a valid
        organization address. Ask the operator to verify LORI_ADDRESS.
      </Alert>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <Button asChild className="w-full" size="lg" variant={variant}>
        <a
          href={connectUrl}
          referrerPolicy={development ? "no-referrer" : undefined}
          rel={development ? "noopener" : undefined}
          target={development ? "_blank" : undefined}
          onClick={() => {
            setAttempted(true);
          }}
        >
          <ExternalLinkIcon />
          {label}
        </a>
      </Button>

      {showHelp && attempted ? (
        <Alert>
          <p>
            {desktopLaunchGuidance(development)}
            {packagedAppUrl ? (
              <>
                {" "}Testing the packaged app instead?{" "}
                <a
                  className="font-medium underline underline-offset-4"
                  href={packagedAppUrl}
                >
                  Open installed Lori
                </a>
                .
              </>
            ) : null}
          </p>
        </Alert>
      ) : null}
    </div>
  );
}
