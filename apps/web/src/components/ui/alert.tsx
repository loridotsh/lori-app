import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type AlertVariant = "default" | "destructive" | "warning" | "success";

const variantStyles: Record<AlertVariant, string> = {
  default: "border-border bg-secondary text-foreground",
  destructive:
    "border-destructive/25 bg-destructive-muted text-destructive-muted-foreground",
  warning:
    "border-warning/30 bg-warning-muted text-warning-muted-foreground",
  success:
    "border-success/25 bg-success-muted text-success-muted-foreground",
};

const variantRoles: Record<AlertVariant, "alert" | "status"> = {
  default: "status",
  destructive: "alert",
  warning: "status",
  success: "status",
};

export function Alert({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: AlertVariant }) {
  return (
    <div
      className={cn(
        "rounded-md border px-3.5 py-3 text-sm leading-relaxed",
        variantStyles[variant],
        className,
      )}
      role={variantRoles[variant]}
      {...props}
    />
  );
}
