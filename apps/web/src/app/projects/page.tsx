import { redirect } from "next/navigation";
export default async function LegacyProjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { project } = await searchParams;
  redirect(typeof project === "string" && /^[0-9a-f-]{36}$/i.test(project) ? `/work/projects/${encodeURIComponent(project)}` : "/work/projects");
}
