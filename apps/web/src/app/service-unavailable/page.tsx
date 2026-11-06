import Link from "next/link";
import { AuthFrame } from "@/components/auth-frame";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function ServiceUnavailablePage() {
  return (
    <AuthFrame
      description="Lori Enterprise could not reach its API or database. Your access has not been changed."
      title="Service temporarily unavailable"
    >
      <div className="space-y-4">
        <Alert variant="warning">
          Wait a moment and try again. If this continues, ask the deployment
          administrator to check the API and database health.
        </Alert>
        <Button asChild className="w-full" variant="outline">
          <Link href="/">Try again</Link>
        </Button>
      </div>
    </AuthFrame>
  );
}
