import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { useTranslation } from '../../../i18n/react.js';
import type { GraphSnapshot, MemoryMapApi, MemoryMapError, MemoryMapFilters, MemoryMapScope, RetrievalAnswer } from '../../../shared/memory-map.js';

export function MemoryQuestionBox({ api, snapshot, scope, filters, onMatches, onSelect }: {
  api: MemoryMapApi; snapshot: GraphSnapshot; scope?: MemoryMapScope; filters: MemoryMapFilters;
  onMatches: (ids: Set<string>) => void; onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<RetrievalAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<MemoryMapError | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setQuestion(''); setAnswer(null); setError(null); setAsking(false); onMatches(new Set());
    return () => { generation.current++; };
  }, [snapshot, filters, scope, api, onMatches]);
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    const current = ++generation.current;
    const queryId = crypto.randomUUID();
    const requestFilters: MemoryMapFilters = {
      ...(filters.sources?.length ? { sources: filters.sources } : {}),
      ...(filters.projectIds?.length ? { projectIds: filters.projectIds } : {}),
      ...(filters.playbookIds?.length ? { playbookIds: filters.playbookIds } : {}),
      ...(filters.text?.trim() ? { text: filters.text } : {}),
    };
    setAsking(true); setError(null); setAnswer(null); onMatches(new Set());
    try {
      const result = await api.retrieve({ scope, question: question.trim(), filters: requestFilters, snapshotId: snapshot.snapshotId, queryId });
      if (current !== generation.current) return;
      if (!result.ok) { setError(result.error); return; }
      const value = result.value;
      if (value.queryId !== queryId || value.snapshotId !== snapshot.snapshotId || value.catalogRevision !== snapshot.catalogRevision) return;
      const currentPoints = new Map(snapshot.points.map(point => [point.memoryId, point]));
      if (value.matches.some(match => {
        const point = currentPoints.get(match.memoryId);
        return !point || point.contentRevision !== match.contentRevision ||
          !!requestFilters.sources?.length && !requestFilters.sources.includes(point.sourceKind) ||
          !!requestFilters.projectIds?.length && (!point.projectId || !requestFilters.projectIds.includes(point.projectId));
      })) return;
      setAnswer(value); onMatches(new Set(value.matches.map(match => match.memoryId)));
    } catch { if (current === generation.current) setError('graph-unavailable'); }
    finally { if (current === generation.current) setAsking(false); }
  };
  return <section aria-label={t('memoryMap.ask')} className="pointer-events-auto flex max-h-full flex-col gap-2 rounded-lg border bg-background p-3 shadow-sm">
    <form className="flex items-center gap-2" onSubmit={event => void handleSubmit(event)}>
      <Input aria-label={t('memoryMap.ask')} placeholder={t('memoryMap.ask')} value={question} maxLength={4000} onChange={event => setQuestion(event.target.value)} className="min-w-0 flex-1 text-sm" />
      <Button type="submit" size="sm" disabled={!question.trim()}>{t('memoryMap.askButton')}</Button>
    </form>
    <p className="text-xs text-muted-foreground">{t('memoryMap.askHint')}</p>
    {asking && <p role="status" className="text-xs">{t('memoryMap.asking')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{t(`memoryMap.error.${error}`)}</p>}
    {answer && <div role="status" className="max-h-48 space-y-3 overflow-auto text-xs">
      {answer.matches.length === 0 ? <p>{t('memoryMap.noMatches')}</p> : answer.answerParts.map((part, index) => <p key={index} className="whitespace-pre-wrap break-words">{part.text}{' '}{part.sourceMemoryIds.map(id => {
        const match = answer.matches.find(row => row.memoryId === id && row.citation === part.citation);
        const point = snapshot.points.find(row => row.memoryId === id);
        return match && point ? <button type="button" key={id} aria-label={t('memoryMap.citation', { number: part.citation, title: point.title })} onClick={() => onSelect(id)} className="mx-1 rounded border px-2 py-1 font-medium hover:bg-accent">[{part.citation}]</button> : null;
      })}</p>)}
    </div>}
  </section>;
}
