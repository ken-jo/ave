import type { Metadata } from "next";
import { NotFoundView } from "@/components/not-found";

/* Built here, then exported as en/404.html by scripts/finish-web-export.mjs, which removes this route. */
export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function Page() {
  return <NotFoundView locale="en" />;
}
