import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { Alert } from "@/components/ui/alert";
import { getSetupStatus } from "@/lib/server-api";
import { SetupForm } from "./setup-form";
import { SetupTokenGuide } from "./setup-token-guide";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const setup = await getSetupStatus();
  if (!setup) {
    return (
      <AuthFrame
        description="The setup service is not responding."
        title="Service unavailable"
      >
        <Alert variant="destructive">
          Check the API and database containers, then reload.
        </Alert>
      </AuthFrame>
    );
  }
  if (setup.state === "ready") {
    redirect("/sign-in");
  }

  const guidance =
    setup.tokenGuidance ?? { source: "docker_compose" as const };

  return (
    <AuthFrame
      description="Create your organization and its first Owner account."
      layout="setup"
      title="Set up Lori Enterprise"
    >
      <div className="space-y-5">
        <SetupTokenGuide guidance={guidance} />
        <SetupForm />
      </div>
    </AuthFrame>
  );
}
