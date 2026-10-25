import type { Metadata } from "next";
import { DocsIndexView } from "@/components/docs";
import { pagesCopy } from "@/lib/pages";

export const metadata: Metadata = {
  title: "문서",
  description: pagesCopy("ko").docs.lead,
  alternates: { canonical: "/docs/", languages: { ko: "/docs/", en: "/en/docs/" } },
};

export default function Page() {
  return <DocsIndexView locale="ko" />;
}
