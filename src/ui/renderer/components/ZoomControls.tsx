import { ToolbarStatusMenuButton } from "./toolbar-status-menu.js";
import { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, nextZoomLevel, normalizeZoomLevel, zoomLevelToZoomFactor, type ZoomCommand } from "../../../shared/app-zoom.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { useOptionalTheme } from "../theme/ThemeProvider.js";
import { useTheme } from "../theme/index.js";

export function ZoomControls() {
  const { t } = useTranslation();
  const { appearance } = useTheme();
  const [level, setLevel] = useState(normalizeZoomLevel(appearance.zoomLevel));
  const [failed, setFailed] = useState(false);
  const levelRef = useRef(level);
  const revisionRef = useRef(0);
  useEffect(() => {
    revisionRef.current++;
    levelRef.current = normalizeZoomLevel(appearance.zoomLevel);
    setLevel(levelRef.current);
  }, [appearance.zoomLevel]);
  const run = (command: ZoomCommand) => {
    const next = nextZoomLevel(levelRef.current, command);
    levelRef.current = next;
    setLevel(next);
    setFailed(false);
    const revision = ++revisionRef.current;
    void getApi().updateSettings({ appearance: { zoomLevel: next } }).catch(() => {
      if (revision !== revisionRef.current) return;
      levelRef.current = normalizeZoomLevel(appearance.zoomLevel);
      setLevel(levelRef.current);
      setFailed(true);
    });
  };
  return <div className="space-y-1" data-testid="zoom-controls">
    <fieldset className="flex items-center gap-2 text-sm" aria-label={t("appearanceTab.zoom")}>
      <Button type="button" variant="outline" size="icon" aria-label={`${t("be_main.menuZoomOut")} (Cmd/Ctrl+-)`} disabled={level === MIN_ZOOM_LEVEL} onClick={() => run("out")}>−</Button>
      <span className="min-w-12 text-center tabular-nums">{Math.round(zoomLevelToZoomFactor(level) * 100)}%</span>
      <Button type="button" variant="outline" size="icon" aria-label={`${t("be_main.menuZoomIn")} (Cmd/Ctrl+=)`} disabled={level === MAX_ZOOM_LEVEL} onClick={() => run("in")}>+</Button>
      <Button type="button" variant="ghost" size="sm" aria-label={`${t("be_main.menuResetZoom")} (Cmd/Ctrl+Num0)`} disabled={level === 0} onClick={() => run("reset")}>{t("appearanceTab.zoomReset")}</Button>
    </fieldset>
    {failed && <p role="alert" className="text-dense text-destructive">{t("appearanceTab.fontSaveFailed")}</p>}
  </div>;
}

export function ZoomIndicator() {
  const theme = useOptionalTheme();
  const { t } = useTranslation();
  const level = normalizeZoomLevel(theme?.appearance.zoomLevel);
  if (level === 0) return null;
  const Icon = level > 0 ? ZoomIn : ZoomOut;
  return <Popover>
    <PopoverTrigger asChild>
      <ToolbarStatusMenuButton menuLabel={t("appearanceTab.zoom")} type="button" variant="ghost" className="h-(--chrome-icon-button) w-(--chrome-icon-button) p-0" data-testid="zoom-indicator" onDoubleClick={(event) => event.stopPropagation()}
        aria-label={`${t("appearanceTab.zoom")} ${Math.round(zoomLevelToZoomFactor(level) * 100)}% (Cmd/Ctrl+= / Cmd/Ctrl+-)`}>
        <Icon size={14} />
      </ToolbarStatusMenuButton>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-auto p-2" onDoubleClick={(event) => event.stopPropagation()}><ZoomControls /></PopoverContent>
  </Popover>;
}
