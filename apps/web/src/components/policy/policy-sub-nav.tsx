"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { catalogTypes } from "@/components/policy/policy-utils";
import { cn } from "@/lib/utils";

export function PolicySubNav({
  basePath,
  personalWorkspace = false,
}: {
  basePath: string;
  /** An individual has no teams to delegate to. */
  personalWorkspace?: boolean;
}) {
  const pathname = usePathname();
  const personalHref = basePath;
  const personalActive =
    pathname === basePath || pathname === `${basePath}/`;
  const segments = basePath.split("/").filter(Boolean);
  const workParams = new URLSearchParams();
  if (segments[0] === "people" && segments[1]) workParams.set("member", decodeURIComponent(segments[1]));
  if (segments[0] === "teams" && segments[1]) {
    workParams.set("team", decodeURIComponent(segments[1]));
    if (segments[2] === "members" && segments[3]) workParams.set("member", decodeURIComponent(segments[3]));
  }

  return (
    <nav
      aria-label="Access sections"
      className="flex max-w-full flex-nowrap gap-x-1 overflow-x-auto overscroll-x-contain border-b border-border pb-px"
    >
      <Link className="-mb-px min-h-11 shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground sm:min-h-0 sm:py-2" href={`/work${workParams.size ? `?${workParams}` : ""}`}>Work access</Link>
      <Link
        aria-current={personalActive ? "page" : undefined}
        className={cn(
          "-mb-px min-h-11 shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:min-h-0 sm:py-2",
          personalActive
            ? "border-primary text-foreground"
            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
        )}
        href={personalHref}
      >
        Personal access
      </Link>
      {catalogTypes.map(({ label, type }) => {
        const href = `${basePath}/catalog/${type}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px min-h-11 shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:min-h-0 sm:py-2",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            href={href}
            key={type}
          >
            {label}
          </Link>
        );
      })}
      {basePath === "/organization" ? (() => {
        const href = `${basePath}/providers`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px min-h-11 shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:min-h-0 sm:py-2",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            href={href}
          >
            Provider connections
          </Link>
        );
      })() : null}
      {basePath === "/organization" && !personalWorkspace ? (() => {
        const href = `${basePath}/delegation`;
        const active = pathname === href;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px min-h-11 shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:min-h-0 sm:py-2",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            href={href}
          >
            Team delegation
          </Link>
        );
      })() : null}
    </nav>
  );
}
