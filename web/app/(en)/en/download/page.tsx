import type { Metadata } from "next";
import { DownloadView } from "@/components/download";
import { pagesCopy } from "@/lib/pages";

export const metadata: Metadata = {
  title: "Download",
  description: pagesCopy("en").download.lead,
  alternates: { canonical: "/en/download/", languages: { ko: "/download/", en: "/en/download/" } },
};

export default function Page() {
  return <DownloadView locale="en" />;
}
