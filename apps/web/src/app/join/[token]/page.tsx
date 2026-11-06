import { AuthFrame } from "@/components/auth-frame";
import { Alert } from "@/components/ui/alert";
import { getJoinPreview, getSetupStatus } from "@/lib/server-api";
import { JoinForm } from "./join-form";

export const dynamic = "force-dynamic";

const messages = {
  expired: "This invitation has expired. Ask an administrator for a new link.",
  invalid: "This invitation link is not valid.",
  revoked: "This invitation was revoked. Ask an administrator for a new link.",
  used: "This invitation has already been used.",
} as const;

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [{ invitation, status }, setup] = await Promise.all([
    getJoinPreview(token),
    getSetupStatus(),
  ]);
  const cloud = setup?.publicSignup === true;

  // An outage says nothing about the link, so it must not read as a bad one.
  if (!invitation && (status >= 500 || status <= 0)) {
    return (
      <AuthFrame
        cloud={cloud}
        description="We couldn’t check this invitation right now."
        title="Service unavailable"
      >
        <Alert variant="warning">
          Your invitation has not been affected. Try this link again in a
          moment.
        </Alert>
      </AuthFrame>
    );
  }

  if (!invitation) {
    return (
      <AuthFrame
        description="The organization could not accept this invitation."
        title="Invitation unavailable"
      >
        <Alert variant="destructive">{messages.invalid}</Alert>
      </AuthFrame>
    );
  }

  if (invitation.state !== "pending") {
    return (
      <AuthFrame
        description="The organization could not accept this invitation."
        title="Invitation unavailable"
      >
        <Alert variant="destructive">{messages[invitation.state]}</Alert>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      cloud={cloud}
      description="Create an account or sign in with the exact email address on the invitation."
      title="You’re invited"
    >
      <JoinForm
        cloud={cloud}
        invitation={{ ...invitation, state: "pending" }}
        token={token}
      />
    </AuthFrame>
  );
}
