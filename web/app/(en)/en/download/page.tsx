import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { DownloadPage } from "@/components/pages";

export const metadata: Metadata = {
  title: "Download",
  alternates: { canonical: "/en/download/", languages: { ko: "/download/", en: "/en/download/" } },
};

export default function Page() {
  return (
    <>
      <Header locale="en" path="/download/" />
      <DownloadPage locale="en" />
      <Footer locale="en" path="/download/" />
    </>
  );
}
