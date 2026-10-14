import type { Metadata } from "next";
import { Footer, Header } from "@/components/chrome";
import { Home } from "@/components/home";

export const metadata: Metadata = { alternates: { canonical: "/en/", languages: { ko: "/", en: "/en/" } } };

export default function Page() {
  return (
    <>
      <Header locale="en" path="/" />
      <Home locale="en" />
      <Footer locale="en" path="/" />
    </>
  );
}
