import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { ChangelogPage } from "@/components/changelog";
import { pagesCopy } from "@/lib/pages";

export const metadata: Metadata = {
  title: "변경 기록",
  description: pagesCopy("ko").changelog.lead,
  alternates: { canonical: "/changelog/", languages: { ko: "/changelog/", en: "/en/changelog/" } },
};

export default function Page() {
  return (
    <>
      <Header locale="ko" path="/changelog/" />
      <ChangelogPage locale="ko" />
      <Footer locale="ko" path="/changelog/" />
    </>
  );
}
