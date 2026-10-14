/*
 * Button from shadcn/ui (notice in web/THIRD_PARTY_NOTICES.md), with the
 * variants trimmed to the three this site uses and the colours bound to the
 * site's tokens (web/DESIGN.md 13, 17, 22).
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium no-underline transition-colors duration-150 motion-safe:active:scale-[0.98] motion-safe:transition-[color,background-color,transform] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-focus",
  {
    variants: {
      variant: {
        default: "bg-ink text-white hover:bg-ink-soft",
        ghost: "bg-white/70 text-ink ring-1 ring-inset ring-line-strong hover:bg-white",
      },
      size: {
        default: "min-h-11 rounded-full px-5 text-[0.9375rem]",
        sm: "min-h-9 rounded-[10px] px-3.5 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.AnchorHTMLAttributes<HTMLAnchorElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/** Every button on this site navigates, so it renders a link (or its child via `asChild`). */
export const Button = React.forwardRef<HTMLAnchorElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "a";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
});
Button.displayName = "Button";
