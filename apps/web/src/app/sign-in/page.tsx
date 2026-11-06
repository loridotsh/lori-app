import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { getSetupStatus, getViewer } from "@/lib/server-api";
import { SignInForm } from "./sign-in-form";
import { safeCallback } from "@/lib/safe-callback";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callback?: string }>;
}) {
  const { callback } = await searchParams;
  const callbackPath = safeCallback(callback);
  const connectingDesktop = callbackPath.startsWith("/connect?");
  const setup = await getSetupStatus();
  if (setup?.state === "requires_setup") {
    redirect("/setup");
  }
  const { status, viewer } = await getViewer();
  if (viewer) {
    redirect(callbackPath);
  }
  // Signed in with no workspace yet, for example after leaving their last one.
  if (status === 403 && setup?.publicSignup) {
    redirect(`/get-started?callback=${encodeURIComponent(callbackPath)}`);
  }

  const publicSignup = setup?.publicSignup === true;
  return (
    <AuthFrame
      cloud={publicSignup}
      description={
        connectingDesktop
          ? "Sign in with your organization account. You’ll confirm this device once before it receives access."
          : publicSignup
            ? "Use the email and password for your Lori account."
            : "Use the email and password associated with this organization."
      }
      title={connectingDesktop ? "Sign in to connect Lori" : "Sign in to Lori"}
    >
      <SignInForm
        callbackPath={callbackPath}
        connectingDesktop={connectingDesktop}
        publicSignup={publicSignup}
      />
    </AuthFrame>
  );
}
