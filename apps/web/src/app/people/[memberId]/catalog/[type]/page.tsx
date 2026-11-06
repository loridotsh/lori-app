import type { PolicyCatalogItemType } from "@lori-enterprise/contracts";
import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { PolicyCatalogManager } from "@/components/policy/policy-catalog-manager";
import { PolicyPageFrame } from "@/components/policy/policy-page-frame";
import { catalogTypeLabel } from "@/components/policy/policy-utils";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { isAdministrator, roleLabel } from "@/lib/authority";
import {
  getMemberPolicy,
  getPolicyCatalog,
  getViewer,
} from "@/lib/server-api";

export const dynamic = "force-dynamic";

const validTypes: PolicyCatalogItemType[] = [
  "app",
  "plugin",
  "skill",
  "provider",
];

export default async function MemberCatalogPage({
  params,
}: {
  params: Promise<{ memberId: string; type: string }>;
}) {
  const { memberId, type } = await params;
  if (!validTypes.includes(type as PolicyCatalogItemType)) {
    redirect(`/people/${encodeURIComponent(memberId)}/catalog/app`);
  }
  const catalogType = type as PolicyCatalogItemType;

  const { status: viewerStatus, viewer } = await getViewer();
  if (!viewer) {
    redirect(apiFailureDestination(viewerStatus));
  }
  if (!isAdministrator(viewer)) {
    redirect("/unauthorized");
  }
  const [{ policy, status }, { catalog, status: catalogStatus }] =
    await Promise.all([getMemberPolicy(memberId), getPolicyCatalog()]);
  if (!policy || !catalog) {
    redirect(apiFailureDestination(status, catalogStatus));
  }

  return (
    <AppShell
      breadcrumb={policy.member.name}
      current="people"
      viewer={viewer}
    >
      <PolicyPageFrame
        basePath={`/people/${encodeURIComponent(memberId)}`}
        header={
          <>
            <Link
              className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              href="/people"
            >
              <ChevronLeftIcon className="size-4" />
              People
            </Link>
            <PageHeader
              description={`Assign or block ${catalogTypeLabel(catalogType).toLowerCase()} for ${policy.member.name}. Unchanged items inherit organization defaults.`}
              eyebrow={roleLabel(policy.member.role)}
              title={`${catalogTypeLabel(catalogType)} access`}
            />
          </>
        }
      >
        <PolicyCatalogManager
          catalog={catalog}
          catalogType={catalogType}
          initialMemberPolicy={policy}
          mode="member"
        />
      </PolicyPageFrame>
    </AppShell>
  );
}
