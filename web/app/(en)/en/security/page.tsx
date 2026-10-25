import type { Metadata } from "next";
import { FeatureView } from "@/components/feature";
import { featurePage } from "@/lib/features";

const meta = featurePage("en", "security").meta;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: "/en/security/", languages: { ko: "/security/", en: "/en/security/" } },
};

export default function Page() {
  return <FeatureView locale="en" feature="security" />;
}
