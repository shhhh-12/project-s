import type { CostItem } from '../domain';
import { transcribePricePerHour } from '../config/models';
import { getGenerationCost, type TranscribeUsage, type Usage } from './openrouter';

export type CostStep = CostItem['step'];
export const COST_STEP_LABELS: Record<CostStep, string> = {
  transcribe: 'Audio transcription',
  thanglish: 'Tamil → Thanglish conversion',
  speakers: 'Speaker identification',
  score: 'Scoring and coaching',
};

/** One chat-model call (OpenRouter reports the billed cost in `usage.cost`). */
export function chatCostItem(step: CostStep, label: string, model: string, usage: Usage): CostItem {
  const cost = typeof usage?.cost === 'number' ? usage.cost : null;
  return {
    step,
    label,
    model,
    ...(typeof usage?.prompt_tokens === 'number' ? { prompt_tokens: usage.prompt_tokens } : {}),
    ...(typeof usage?.completion_tokens === 'number' ? { completion_tokens: usage.completion_tokens } : {}),
    cost,
    source: cost === null ? 'unavailable' : 'reported',
  };
}

/** One speech-to-text request: reported cost, else the billed cost looked up by generation id, else the published per-hour price. */
export async function transcribeCostItem(key: string, model: string, label: string, seconds: number, usage: TranscribeUsage): Promise<CostItem> {
  const base = { step: 'transcribe' as const, label, model, seconds: Math.round(seconds * 10) / 10 };
  if (typeof usage.cost === 'number') return { ...base, cost: usage.cost, source: 'reported' };
  if (usage.generationId) {
    const billed = await getGenerationCost(key, usage.generationId);
    if (billed !== null) return { ...base, cost: billed, source: 'reported' };
  }
  const perHour = transcribePricePerHour[model];
  if (perHour !== undefined) return { ...base, cost: (perHour * seconds) / 3600, source: 'estimated' };
  return { ...base, cost: null, source: 'unavailable' };
}

export function summarizeCosts(items: CostItem[]) {
  const steps = (Object.keys(COST_STEP_LABELS) as CostStep[])
    .map((step) => {
      const rows = items.filter((item) => item.step === step);
      return { step, label: COST_STEP_LABELS[step], calls: rows.length, cost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0) };
    })
    .filter((row) => row.calls > 0);
  return {
    steps,
    total: items.reduce((sum, item) => sum + (item.cost ?? 0), 0),
    missing: items.filter((item) => item.cost === null).length,
    estimated: items.filter((item) => item.source === 'estimated').length,
  };
}

export const formatUsd = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(value >= 0.01 ? 4 : 6)}`);
