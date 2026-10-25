/** Show server execution and requested capabilities before adding it. */
import { useTranslation } from "../../../../i18n/react.js";
import type { McpRuntimeView } from "../../../../shared/git-marketplace.js";

export function McpRuntimeSummary({ runtime }: { runtime: McpRuntimeView }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5" data-testid="git-marketplace:mcp-runtime">
      <code className="block break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
        {runtime.transport === "http" ? runtime.url : [runtime.command, ...runtime.args].join(" ")}
      </code>
      {runtime.env.length > 0 && (
        <div className="text-xs">
          <span className="text-muted-foreground">{t("gitMarketplace.mcp.asksFor")} </span>
          {runtime.env.map((item) => (
            <span key={item.name} className="mr-2 font-mono">
              {item.name}
              {item.secret ? ` (${t("gitMarketplace.mcp.secret")})` : ""}
              {item.required ? ` (${t("gitMarketplace.mcp.required")})` : ""}
            </span>
          ))}
        </div>
      )}
      {runtime.usesDataDir && <p className="text-xs text-muted-foreground">{t("gitMarketplace.mcp.dataDir")}</p>}
    </div>
  );
}
