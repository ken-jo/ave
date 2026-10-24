import { useState } from "react";
import { Globe } from "lucide-react";
import { faviconSource } from "../preview/favicon-source.js";

export function BrowserFavicon({ source }: { source: string | null }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const allowedSource = faviconSource(source);
  return allowedSource && allowedSource !== failedSource
    ? <img src={allowedSource} alt="" width={16} height={16} className="size-4 shrink-0" onError={() => setFailedSource(allowedSource)} />
    : <Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
}
