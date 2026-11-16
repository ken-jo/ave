import { Graph } from '@cosmos.gl/graph';
import type { GraphSnapshot, MemoryMapSource } from '../../../shared/memory-map.js';

export const MEMORY_SOURCE_TOKENS: Record<MemoryMapSource, string> = Object.freeze({ user: 'chart-1', assistant: 'chart-2', import: 'chart-3', capture: 'chart-4', unknown: 'chart-5' });
export interface MemoryGraphLabel { id: string; text: string; x: number; y: number }
export interface MemoryGraphCallbacks {
  onSelect: (id: string) => void;
  onHover: (value: { title: string; x: number; y: number } | null) => void;
  onLabels: (labels: MemoryGraphLabel[]) => void;
  onError: () => void;
}
export interface MemoryGraphRenderer {
  update: (snapshot: GraphSnapshot, visible: Set<string>, selected: string | null, matched?: Set<string>) => void;
  zoom: (factor: number) => void;
  fit: () => void;
  destroy: () => void;
}

function tokenColor(container: HTMLElement, token: string): number[] {
  const probe = document.createElement('span');
  probe.style.color = `var(--${token})`;
  container.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('Color context unavailable');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data).map(channel => channel / 255);
}

export function createMemoryGraph(container: HTMLDivElement, callbacks: MemoryGraphCallbacks): MemoryGraphRenderer {
  let disposed = false;
  let failed = false;
  let ready = false;
  let snapshot: GraphSnapshot | null = null;
  let visible = new Set<string>();
  let selected: string | null = null;
  let matched = new Set<string>();
  let hovered: string | null = null;
  let fitted = false;
  let fitZoom = 1;
  const handleFailure = () => {
    if (disposed || failed) return;
    failed = true;
    graph?.destroy();
    callbacks.onHover(null); callbacks.onLabels([]); callbacks.onError();
  };
  const handleContextLoss = (event: Event) => { event.preventDefault(); handleFailure(); };
  container.addEventListener('webglcontextlost', handleContextLoss, true);
  let graph: Graph | undefined;
  const publishLabels = () => {
    if (!graph || !snapshot || disposed || failed || !ready) return;
    if (graph.getZoomLevel() < fitZoom * 1.6) { callbacks.onLabels([]); return; }
    const groups = new Map<string, { text: string; x: number; y: number; count: number }>();
    for (const point of snapshot.points) {
      if (!visible.has(point.memoryId) || !point.projectId || !point.projectName) continue;
      const group = groups.get(point.projectId) ?? { text: point.projectName, x: 0, y: 0, count: 0 };
      group.x += point.x; group.y += point.y; group.count++; groups.set(point.projectId, group);
    }
    callbacks.onLabels([...groups].map(([id, group]) => {
      const [x, y] = graph!.spaceToScreenPosition([group.x / group.count, group.y / group.count]);
      return { id, text: group.text, x, y };
    }));
  };
  const paint = () => {
    if (!graph || !snapshot || !ready || disposed || failed) return;
    try {
      const palette = Object.fromEntries(Object.entries(MEMORY_SOURCE_TOKENS).map(([kind, token]) => [kind, tokenColor(container, token)]));
      const lineColor = tokenColor(container, 'muted-foreground');
      const indices = new Map(snapshot.points.map((point, i) => [point.memoryId, i]));
      const edges = snapshot.edges.filter(edge => visible.has(edge.a) && visible.has(edge.b));
      graph.setPointPositions(new Float32Array(snapshot.points.flatMap(point => [point.x, point.y])), true);
      graph.setPointColors(new Float32Array(snapshot.points.flatMap(point => [...palette[point.sourceKind]!.slice(0, 3), visible.has(point.memoryId) ? 1 : 0.12])));
      graph.setPointSizes(new Float32Array(snapshot.points.map(point => point.memoryId === selected || matched.has(point.memoryId) ? 9 : 5)));
      graph.setLinks(new Float32Array(edges.flatMap(edge => [indices.get(edge.a)!, indices.get(edge.b)!])));
      const emphasized = (a: string, b: string) => [selected, hovered].some(id => id === a || id === b);
      graph.setLinkColors(new Float32Array(edges.flatMap(edge => [...lineColor.slice(0, 3), emphasized(edge.a, edge.b) ? 0.8 : 0.12])));
      graph.setLinkWidths(new Float32Array(edges.map(edge => emphasized(edge.a, edge.b) ? 1.5 : 0.5)));
      graph.setConfigPartial({ outlinedPointIndices: snapshot.points.flatMap((point, i) => visible.has(point.memoryId) && (matched.has(point.memoryId) || point.memoryId === selected) ? [i] : []) });
      graph.render(undefined, 0);
      if (!fitted) { fitted = true; graph.fitView(0, 0.15, false); fitZoom = graph.getZoomLevel(); }
      publishLabels();
    } catch { handleFailure(); }
  };
  try {
    graph = new Graph(container, {
      enableSimulation: false, enableSimulationDuringZoom: false, enableDrag: false,
      rescalePositions: false, transitionDuration: 0, fitViewOnInit: false,
      backgroundColor: [0, 0, 0, 0], renderHoveredPointRing: false, attribution: '',
      onPointClick: (index: number) => { const point = snapshot?.points[index]; if (point && visible.has(point.memoryId) && !failed) callbacks.onSelect(point.memoryId); },
      onPointMouseOver: (index: number) => {
        const point = snapshot?.points[index];
        if (!point || !visible.has(point.memoryId) || failed) return;
        hovered = point.memoryId;
        const [x, y] = graph!.spaceToScreenPosition([point.x, point.y]);
        callbacks.onHover({ title: point.title, x, y }); paint();
      },
      onPointMouseOut: () => { hovered = null; callbacks.onHover(null); paint(); },
      onZoom: () => { callbacks.onHover(null); publishLabels(); },
    });
    void graph.ready.then(() => { if (!disposed && !failed) { ready = true; paint(); } }).catch(handleFailure);
  } catch { handleFailure(); }
  const themeObserver = new MutationObserver(paint);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  const resizeObserver = new ResizeObserver(publishLabels);
  resizeObserver.observe(container);
  return {
    update: (next, ids, selection, matches = new Set()) => {
      if (snapshot?.snapshotId !== next.snapshotId) fitted = false;
      snapshot = next; visible = ids; selected = selection; matched = matches;
      hovered = null; callbacks.onHover(null); paint();
    },
    zoom: factor => { if (ready && !failed && !disposed) graph?.zoom(factor, 0, false); },
    fit: () => { if (ready && !failed && !disposed) { graph?.fitView(0, 0.15, false); fitZoom = graph?.getZoomLevel() ?? 1; publishLabels(); } },
    destroy: () => {
      if (disposed) return;
      disposed = true; themeObserver.disconnect(); resizeObserver.disconnect();
      container.removeEventListener('webglcontextlost', handleContextLoss, true);
      if (!failed) graph?.destroy();
      container.replaceChildren();
    },
  };
}
