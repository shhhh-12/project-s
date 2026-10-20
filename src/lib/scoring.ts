import { RUBRIC } from '../config/rubric';
import type { Analysis, Criterion } from '../domain';

export type ScoreBand = 'Excellent' | 'Good' | 'Needs improvement' | 'Poor' | 'Insufficient evidence' | 'Unscored';
export type ScoreResult = {
  total: number; raw: number; band: ScoreBand; coverage: number; provisional: boolean;
  gate: { failed: boolean; reason?: string }; rubric_version: string;
  /** Kept for existing UI/export callers. */
  compliance_status: 'PASS' | 'FAIL';
};

export function scoreCall(criteria: Criterion[], redFlags = 0, opts: { redFlagReasons?: string[] } = {}): ScoreResult {
  const weights = new Map(RUBRIC.criteria.map(c => [c.id as string, c.weight]));
  const allWeight = [...weights.values()].reduce((n, w) => n + w, 0);
  const applicable = criteria.filter(c => c.score !== null && c.verified && weights.has(c.id));
  const weighted = applicable.reduce((n, c) => n + (weights.get(c.id) as number) * ((c.score as number) / 3), 0);
  const applicableWeight = applicable.reduce((n, c) => n + (weights.get(c.id) as number), 0);
  const raw = applicableWeight ? (weighted / applicableWeight) * 100 : 0;
  const coverage = allWeight ? applicableWeight / allWeight : 0;
  const provisional = coverage < 0.6;

  const compliance = criteria.find(c => c.id === 'compliance');
  const complianceAssessed = !!compliance && compliance.score !== null && compliance.verified;
  const reasons: string[] = [];
  if (redFlags > 0) reasons.push(opts.redFlagReasons?.length ? opts.redFlagReasons.join('; ') : `${redFlags} verified red flag(s)`);
  if (complianceAssessed && compliance!.score === 0) reasons.push('Compliance score 0');
  const failed = reasons.length > 0;
  const reason = failed ? reasons.join('; ') : complianceAssessed ? undefined : 'Compliance not assessed';

  const total = Math.min(raw, failed ? 50 : 100);
  const band: ScoreBand = applicableWeight === 0 ? 'Unscored' : provisional ? 'Insufficient evidence'
    : total >= 85 ? 'Excellent' : total >= 70 ? 'Good' : total >= 55 ? 'Needs improvement' : 'Poor';
  return {
    total: Number(total.toFixed(1)), raw: Number(raw.toFixed(1)), band,
    coverage: Number(coverage.toFixed(3)), provisional,
    gate: reason === undefined ? { failed } : { failed, reason },
    rubric_version: RUBRIC.id, compliance_status: failed ? 'FAIL' : 'PASS',
  };
}

export const redFlagReasonsOf = (analysis: Pick<Analysis, 'red_flags'>) => analysis.red_flags.map((f) => `${f.type} [${f.timestamp}]`);

/** Stored score if present, else recomputed (records saved before step 09). */
export function getScore(analysis: Analysis): ScoreResult {
  if (analysis.score) {
    return { ...analysis.score, band: analysis.score.band as ScoreBand, compliance_status: analysis.score.gate.failed ? 'FAIL' : 'PASS' };
  }
  return scoreCall(analysis.criteria, analysis.red_flags.length, { redFlagReasons: redFlagReasonsOf(analysis) });
}