import type { ReactNode } from "react";
import { PolicySubNav } from "@/components/policy/policy-sub-nav";

export function PolicyPageFrame({
  basePath,
  children,
  header,
  personalWorkspace = false,
}: {
  basePath: string;
  children: ReactNode;
  header: ReactNode;
  personalWorkspace?: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">{header}</div>
      <PolicySubNav basePath={basePath} personalWorkspace={personalWorkspace} />
      {children}
    </div>
  );
}
