import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Footer, Header } from "@/components/chrome";
import { DocArticle } from "@/components/pages";
import { DOC_SLUGS, docPage } from "@/lib/docs";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOC_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = docPage("en", slug);
  if (!page) return {};
  return {
    title: page.title,
    description: page.summary,
    alternates: { canonical: `/en/docs/${slug}/`, languages: { ko: `/docs/${slug}/`, en: `/en/docs/${slug}/` } },
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = docPage("en", slug);
  if (!page) notFound();
  return (
    <>
      <Header locale="en" path={`/docs/${slug}/`} />
      <DocArticle locale="en" page={page} />
      <Footer locale="en" path={`/docs/${slug}/`} />
    </>
  );
}
