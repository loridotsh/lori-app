import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { getViewer } from "@/lib/server-api";
import { WorkRouteShell } from "@/components/work/work-route-shell";
import { WorkNotificationsProvider } from "@/components/work/notifications/provider";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  description: "Manage your team, devices, and organization access for Lori Enterprise.",
  robots: {
    follow: false,
    index: false,
  },
  title: "Lori Enterprise",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { viewer } = await getViewer();
  return (
    <html className={fontVariables} lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
        >
          {viewer ? <WorkNotificationsProvider key={`${viewer.organization.id}:${viewer.user.id}`} viewer={viewer}><WorkRouteShell viewer={viewer}>{children}</WorkRouteShell></WorkNotificationsProvider> : children}
        </ThemeProvider>
      </body>
    </html>
  );
}
