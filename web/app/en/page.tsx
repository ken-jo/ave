import type { Metadata } from "next";
import { Hero } from "@/components/landing/hero";
import { DocsIndex, Flow, Statement, Trust } from "@/components/landing/features";
import { Downloads } from "@/components/landing/downloads";
import { Closing } from "@/components/landing/closing";

export const metadata: Metadata = {
  title: { absolute: "Ave — Quiet about signals, clear about decisions" },
  alternates: { canonical: "/en" },
};

export default function LandingPageEn() {
  return (
    <>
      <Hero locale="en" />
      <Statement locale="en" />
      <Flow locale="en" />
      <Trust locale="en" />
      <Downloads locale="en" />
      <DocsIndex locale="en" />
      <Closing locale="en" />
    </>
  );
}
