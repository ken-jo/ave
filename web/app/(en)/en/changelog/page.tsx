import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { ChangelogPage } from "@/components/changelog";
import { pagesCopy } from "@/lib/pages";

export const metadata: Metadata = {
  title: "Changelog",
  description: pagesCopy("en").changelog.lead,
  alternates: { canonical: "/en/changelog/", languages: { ko: "/changelog/", en: "/en/changelog/" } },
};

export default function Page() {
  return (
    <>
      <Header locale="en" path="/changelog/" />
      <ChangelogPage locale="en" />
      <Footer locale="en" path="/changelog/" />
    </>
  );
}
