import type { Metadata } from "next";
import { NotFoundView } from "@/components/not-found";

/* Built here, then exported as 404.html by scripts/finish-web-export.mjs, which removes this route. */
export const metadata: Metadata = { title: "페이지 없음", robots: { index: false } };

export default function Page() {
  return <NotFoundView locale="ko" />;
}
