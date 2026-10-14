import { Shell, siteMetadata } from "@/components/shell";

export const metadata = siteMetadata("ko");
export { viewport } from "@/components/shell";

export default function KoLayout({ children }: { children: React.ReactNode }) {
  return <Shell locale="ko">{children}</Shell>;
}
