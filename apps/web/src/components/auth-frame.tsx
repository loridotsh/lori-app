import type { ReactNode } from "react";
import { Building2Icon, KeyRoundIcon, ServerIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { LoriLogo } from "@/components/lori-logo";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";

const pillars = [
  {
    description:
      "The control plane runs on infrastructure your operator owns end to end.",
    icon: ServerIcon,
    title: "Self-hosted company address",
  },
  {
    description:
      "Each desktop binds to a PKCE handshake with rotating per-device tokens.",
    icon: KeyRoundIcon,
    title: "Per-device rotating credentials",
  },
  {
    description:
      "Revoke any compromised installation instantly from this dashboard.",
    icon: ShieldCheckIcon,
    title: "Immediate access revocation",
  },
] as const;

const cloudPillars = [
  {
    description: "Sign up and use Lori in your own private workspace.",
    icon: UserRoundIcon,
    title: "Individual accounts",
  },
  {
    description: "Create an organization, invite people and set shared policy.",
    icon: Building2Icon,
    title: "Enterprise organizations",
  },
  {
    description: "Join a company and keep your personal workspace separate.",
    icon: KeyRoundIcon,
    title: "One account for both",
  },
] as const;

export function AuthFrame({
  children,
  cloud = false,
  description,
  title,
  layout = "default",
}: {
  children: ReactNode;
  /** Hosted by Lori rather than self-hosted by the reader's own operator. */
  cloud?: boolean;
  description: string;
  title: string;
  layout?: "default" | "setup";
}) {
  const brandPillars = cloud ? cloudPillars : pillars;
  return (
    <main className={cn("grid min-h-dvh bg-background text-foreground", layout === "setup" ? "lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]" : "lg:grid-cols-[minmax(24rem,0.9fr)_1.1fr]")}>
      {/* Brand panel — a disciplined second surface, no decorative blur */}
      {/* Sticky so the form's height can never push this panel around. */}
      <section className="relative hidden flex-col justify-between border-r border-border bg-sidebar px-10 py-10 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:self-start lg:overflow-hidden xl:px-14 xl:py-12">
        <div className="relative">
          <LoriLogo label={cloud ? "Lori" : undefined} />
        </div>

        <div className={cn("relative my-auto max-w-md", layout === "setup" ? "py-6" : "py-10")}>
          {layout !== "setup" && <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {cloud ? "Lori Cloud" : "Lori Enterprise Control Plane"}
          </p>}
          <h2 className="mt-4 text-[1.75rem] font-semibold leading-[1.2] tracking-tight text-foreground xl:text-[2rem]">
            {cloud ? "Lori for you and your whole team." : "One trusted boundary for every Lori member."}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            {cloud
              ? "Create an account in a minute. Work on your own, or bring your organization and manage access in one place."
              : "Invite teams, approve Lori installations, and enforce continuous security policy from infrastructure under your direct control."}
          </p>

          <ul className="mt-8 space-y-4 [@media(max-height:640px)]:hidden">
            {brandPillars.map(({ description, icon: Icon, title: itemTitle }) => (
              <li key={itemTitle} className="flex items-start gap-3.5">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {itemTitle}
                  </p>
                  {layout !== "setup" && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {description}
                  </p>}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full rounded-full bg-success/60 status-dot-pulse" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          {cloud ? "Hosted by Lori" : <>Self-hosted &amp; controlled by your organization operator</>}
        </div>
      </section>

      {/* Form column */}
      <section className={cn("relative flex min-h-dvh min-w-0 justify-center sm:px-8 lg:px-12", layout === "setup" ? "items-start px-5 pb-10 pt-6 sm:pb-12 lg:pt-16" : "items-start px-4 pb-8 pt-5 sm:items-center sm:py-10")}>
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>
        <div className={cn("w-full min-w-0", layout === "setup" ? "max-w-xl space-y-6" : "max-w-[28rem] space-y-6")}>
          <div className="pr-12 lg:hidden">
            <LoriLogo label={cloud ? "Lori" : undefined} />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {title}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
