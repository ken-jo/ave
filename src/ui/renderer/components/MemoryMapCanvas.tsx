import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { useTranslation } from '../../../i18n/react.js';
import type { GraphSnapshot } from '../../../shared/memory-map.js';
import { createMemoryGraph, type MemoryGraphLabel, type MemoryGraphRenderer } from './memory-graph-renderer.js';

export function MemoryMapCanvas({ snapshot, visible, selected, matched, onSelect }: {
  snapshot: GraphSnapshot; visible: Set<string>; selected: string | null; matched?: Set<string>; onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<MemoryGraphRenderer | null>(null);
  const select = useRef(onSelect); select.current = onSelect;
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ title: string; x: number; y: number } | null>(null);
  const [labels, setLabels] = useState<MemoryGraphLabel[]>([]);
  useEffect(() => {
    const graph = createMemoryGraph(container.current!, { onSelect: id => select.current(id), onHover: setHover, onLabels: setLabels, onError: () => setFailed(true) });
    renderer.current = graph;
    return () => { renderer.current = null; graph.destroy(); };
  }, []);
  useEffect(() => { renderer.current?.update(snapshot, visible, selected, matched); }, [snapshot, visible, selected, matched]);
  return <div className="absolute inset-0 overflow-hidden" role="group" aria-label={t('memoryMap.canvas')}>
    <div ref={container} className="absolute inset-0" aria-hidden="true" />
    {failed ? <p role="alert" className="absolute inset-x-4 top-4 rounded-md border bg-background p-4 text-sm">{t('memoryMap.webglFailed')}</p> : <>
      {labels.map(label => <span key={label.id} className="pointer-events-none absolute max-w-40 truncate rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground" style={{ left: label.x, top: label.y }}>{label.text}</span>)}
      {hover && <div role="tooltip" className="pointer-events-none absolute max-w-60 break-words rounded-md border bg-popover p-2 text-xs text-popover-foreground" style={{ left: Math.max(8, Math.min(hover.x + 12, (container.current?.clientWidth ?? 300) - 240)), top: Math.max(8, hover.y - 32) }}>{hover.title}</div>}
      <div className="absolute right-3 top-3 flex gap-1 rounded-md border bg-background p-1">
        <Button size="sm" variant="ghost" aria-label={t('memoryMap.zoomIn')} onClick={() => renderer.current?.zoom(1.5)}>+</Button>
        <Button size="sm" variant="ghost" aria-label={t('memoryMap.zoomOut')} onClick={() => renderer.current?.zoom(1 / 1.5)}>−</Button>
        <Button size="sm" variant="ghost" onClick={() => renderer.current?.fit()}>{t('memoryMap.fit')}</Button>
      </div>
    </>}
  </div>;
}
