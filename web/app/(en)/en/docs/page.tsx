import type { Metadata } from "next";
import { DocsIndexView } from "@/components/docs";
import { pagesCopy } from "@/lib/pages";

export const metadata: Metadata = {
  title: "Docs",
  description: pagesCopy("en").docs.lead,
  alternates: { canonical: "/en/docs/", languages: { ko: "/docs/", en: "/en/docs/" } },
};

export default function Page() {
  return <DocsIndexView locale="en" />;
}
