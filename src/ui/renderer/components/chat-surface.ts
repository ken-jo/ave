import { cva } from "class-variance-authority";

/** Shared frame for the composer, its notices, and conversation decisions. */
export const chatSurface = cva(
  "border border-input-bar-border bg-input-bar transition-colors duration-(--motion-fast) ease-(--motion-ease-out) motion-reduce:transition-none",
  {
    variants: {
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
    defaultVariants: { shape: "card", elevation: "raised" },
  },
);
