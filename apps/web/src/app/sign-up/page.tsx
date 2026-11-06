import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { safeCallback } from "@/lib/safe-callback";
import { getSetupStatus, getViewer } from "@/lib/server-api";
import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ callback?: string; type?: string }>;
}) {
  const { callback, type } = await searchParams;
  const callbackPath = safeCallback(callback);
  const setup = await getSetupStatus();
  if (!setup?.publicSignup) {
    redirect("/sign-in");
  }
  const { status, viewer } = await getViewer();
  if (viewer) {
    redirect(callbackPath);
  }
  // Signed in with no workspace yet, for example after a removal.
  if (status === 403) {
    redirect(`/get-started?callback=${encodeURIComponent(callbackPath)}`);
  }

  return (
    <AuthFrame
      cloud
      description="Start on your own or create an organization for your team."
      title="Create your Lori account"
    >
      <SignUpForm
        callbackPath={callbackPath}
        initialKind={type === "enterprise" ? "enterprise" : "personal"}
      />
    </AuthFrame>
  );
}
