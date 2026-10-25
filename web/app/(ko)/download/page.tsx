import type { Metadata } from "next";
import { DownloadView } from "@/components/download";
import { pagesCopy } from "@/lib/pages";

export const metadata: Metadata = {
  title: "내려받기",
  description: pagesCopy("ko").download.lead,
  alternates: { canonical: "/download/", languages: { ko: "/download/", en: "/en/download/" } },
};

export default function Page() {
  return <DownloadView locale="ko" />;
}
