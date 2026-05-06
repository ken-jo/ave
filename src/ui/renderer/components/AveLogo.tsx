import { useId } from "react";
import { AVE_LOGO_PATH, AVE_LOGO_VIEW_BOX } from "../../../shared/ave-logo.js";

interface AveLogoProps {
  className?: string;
  title?: string;
  decorative?: boolean;
}

export function AveLogo({ className, title = "Ave", decorative = false }: AveLogoProps) {
  const gradientId = `aveLogoGradient${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className}
      width="230"
      height="233"
      viewBox={AVE_LOGO_VIEW_BOX}
      fill="none"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={AVE_LOGO_PATH} fill={`url(#${gradientId})`} />
      <defs>
        <linearGradient id={gradientId} x1="50.1574" y1="-3.85755" x2="181.301" y2="235.331" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF0000" />
          <stop offset="1" stopColor="#D900FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
