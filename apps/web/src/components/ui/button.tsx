import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55 active:translate-y-px motion-reduce:transform-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover active:bg-primary-active",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-destructive/95",
        outline:
          "border border-border bg-card text-foreground hover:bg-secondary hover:border-border-strong",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70 border border-transparent",
        ghost:
          "text-foreground hover:bg-secondary hover:text-secondary-foreground",
        link:
          "text-primary underline-offset-4 hover:underline rounded-none",
      },
      size: {
        default: "h-11 px-4 text-sm sm:h-9 sm:px-3.5",
        sm: "h-11 gap-1.5 px-3.5 text-sm sm:h-8 sm:px-3 sm:text-xs",
        lg: "h-11 px-5 text-sm font-semibold sm:h-10",
        icon: "size-11 sm:size-9",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export function Button({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      className={cn(buttonVariants({ className, size, variant }))}
      data-slot="button"
      {...props}
    />
  );
}

export { buttonVariants };
