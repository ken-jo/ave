import { cva } from "class-variance-authority";

/** Shared frame for the composer, its notices, and conversation decisions. */
export const chatSurface = cva(
  "border bg-input-bar transition-colors duration-(--motion-fast) ease-(--motion-ease-out) motion-reduce:transition-none",
  {
    variants: {
      edge: {
        standard: "border-input-bar-border",
        quiet: "border-border-subtle",
      },
      shape: {
        card: "rounded-xl",
        chip: "rounded-full",
      },
      elevation: {
        raised: "shadow-[var(--elevation-raised)]",
        floating: "shadow-[var(--elevation-floating)]",
        flat: "shadow-none",
      },
    },
    defaultVariants: { edge: "standard", shape: "card", elevation: "raised" },
  },
);
