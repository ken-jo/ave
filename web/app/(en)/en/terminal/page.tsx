import type { Metadata } from "next";
import { FeatureView } from "@/components/feature";
import { featurePage } from "@/lib/features";

const meta = featurePage("en", "terminal").meta;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: "/en/terminal/", languages: { ko: "/terminal/", en: "/en/terminal/" } },
};

export default function Page() {
  return <FeatureView locale="en" feature="terminal" />;
}
