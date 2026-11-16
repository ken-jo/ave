import '../../../../../test/renderer/setup.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../../../../shared/memory-map.js';
import { createMemoryGraph } from '../memory-graph-renderer.js';

const mock = vi.hoisted(() => ({ config: {} as Record<string, (...args: unknown[]) => void>, graph: { ready: Promise.resolve(), setPointPositions: vi.fn(), setPointColors: vi.fn(), setPointSizes: vi.fn(), setLinks: vi.fn(), setLinkColors: vi.fn(), setLinkWidths: vi.fn(), setConfigPartial: vi.fn(), render: vi.fn(), fitView: vi.fn(), getZoomLevel: vi.fn(() => 1), spaceToScreenPosition: vi.fn((value: number[]) => value), zoom: vi.fn(), destroy: vi.fn() } }));
vi.mock('@cosmos.gl/graph', () => ({ Graph: class {
  constructor(container: HTMLDivElement, config: typeof mock.config) { mock.config = config; container.append(document.createElement('canvas')); return mock.graph; }
} }));
afterEach(() => { vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), getImageData: () => ({ data: [30, 40, 50, 255] }) } as unknown as CanvasRenderingContext2D);
  const container = document.createElement('div'); document.body.append(container);
  const callbacks = { onSelect: vi.fn(), onHover: vi.fn(), onLabels: vi.fn(), onError: vi.fn() };
  const renderer = createMemoryGraph(container, callbacks);
  const snapshot = { snapshotId: 's', points: [
    { memoryId: 'a', sourceKind: 'user', title: 'Visible', x: 12, y: 34, projectId: 'project', projectName: 'Project' },
    { memoryId: 'b', sourceKind: 'assistant', title: 'Dimmed', x: 56, y: 78 },
  ], edges: [{ a: 'a', b: 'b', similarity: 0.82 }] } as GraphSnapshot;
  return { container, callbacks, renderer, snapshot };
}
describe('memory graph adapter', () => {
  it('uses fixed host coordinates, dims excluded points and refuses their selection and hover', async () => {
    const { renderer, snapshot, callbacks } = setup();
    renderer.update(snapshot, new Set(['a']), 'a'); await Promise.resolve();
    expect(mock.config).toMatchObject({ enableSimulation: false, enableSimulationDuringZoom: false, enableDrag: false, transitionDuration: 0, rescalePositions: false });
    expect(mock.graph.setPointPositions).toHaveBeenLastCalledWith(new Float32Array([12, 34, 56, 78]), true);
    expect(mock.graph.setLinks).toHaveBeenLastCalledWith(new Float32Array());
    const colors = mock.graph.setPointColors.mock.lastCall![0] as Float32Array;
    expect(colors[3]).toBe(1); expect(colors[7]).toBeCloseTo(0.12);
    mock.config.onPointClick!(1); mock.config.onPointMouseOver!(1);
    expect(callbacks.onSelect).not.toHaveBeenCalled(); expect(callbacks.onHover).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Dimmed' }));
    mock.config.onPointClick!(0); expect(callbacks.onSelect).toHaveBeenCalledWith('a');
    renderer.destroy();
  });
  it('publishes a visible failure on context loss and destroys only once', async () => {
    const { renderer, snapshot, callbacks, container } = setup();
    renderer.update(snapshot, new Set(['a', 'b']), null); await Promise.resolve();
    const before = mock.graph.destroy.mock.calls.length;
    const event = new Event('webglcontextlost', { cancelable: true });
    container.querySelector('canvas')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(callbacks.onError).toHaveBeenCalledOnce();
    renderer.destroy(); renderer.destroy();
    expect(mock.graph.destroy.mock.calls.length - before).toBe(1);
    expect(container.childElementCount).toBe(0);
    mock.config.onPointClick!(0); expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
  it('shows only real project labels at closer zoom, emphasizes edges and refreshes theme tokens', async () => {
    const { renderer, snapshot, callbacks } = setup();
    renderer.update(snapshot, new Set(['a', 'b']), 'a', new Set(['b'])); await Promise.resolve();
    expect(mock.graph.setLinkWidths).toHaveBeenLastCalledWith(new Float32Array([1.5]));
    expect(mock.graph.setPointSizes).toHaveBeenLastCalledWith(new Float32Array([9, 9]));
    mock.graph.getZoomLevel.mockReturnValue(3); mock.config.onZoom!();
    expect(callbacks.onLabels).toHaveBeenLastCalledWith([{ id: 'project', text: 'Project', x: 12, y: 34 }]);
    const before = mock.graph.setPointColors.mock.calls.length;
    document.documentElement.classList.add('dark'); await Promise.resolve();
    expect(mock.graph.setPointColors.mock.calls.length).toBeGreaterThan(before);
    renderer.destroy(); const after = mock.graph.setPointColors.mock.calls.length;
    document.documentElement.classList.remove('dark'); await Promise.resolve();
    expect(mock.graph.setPointColors).toHaveBeenCalledTimes(after);
    mock.config.onPointClick!(0); expect(callbacks.onSelect).not.toHaveBeenCalled();
    mock.graph.getZoomLevel.mockReturnValue(1);
  });
  it('handles initialization rejection and removes observers and event handlers during teardown', async () => {
    const original = mock.graph.ready;
    let reject!: (error: Error) => void;
    mock.graph.ready = new Promise<void>((_resolve, fail) => { reject = fail; });
    const { renderer, callbacks, container } = setup();
    reject(new Error('Context unavailable')); await Promise.resolve(); await Promise.resolve();
    expect(callbacks.onError).toHaveBeenCalledOnce();
    renderer.destroy(); container.dispatchEvent(new Event('webglcontextlost'));
    expect(callbacks.onError).toHaveBeenCalledOnce(); mock.graph.ready = original;
  });
});
