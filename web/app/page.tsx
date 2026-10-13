import type { Metadata } from "next";
import { Hero } from "@/components/landing/hero";
import { DocsIndex, Flow, Statement, Trust } from "@/components/landing/features";
import { Downloads } from "@/components/landing/downloads";
import { Closing } from "@/components/landing/closing";

export const metadata: Metadata = {
  title: { absolute: "Ave — 일의 신호는 조용히, 결정은 당신이" },
  alternates: { canonical: "/" },
};

export default function LandingPage() {
  return (
    <>
      <Hero locale="ko" />
      <Statement locale="ko" />
      <Flow locale="ko" />
      <Trust locale="ko" />
      <Downloads locale="ko" />
      <DocsIndex locale="ko" />
      <Closing locale="ko" />
    </>
  );
}
