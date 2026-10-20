import { z } from 'zod';

export const criterionIds = [
  'opening_rapport',
  'lead_context',
  'discovery',
  'listening_control',
  'solution_fit',
  'objection_handling',
  'closing_next_step',
  'compliance',
] as const;
export type CriterionId = (typeof criterionIds)[number];

export const SpeakerSchema = z.enum(['rep', 'customer', 'unknown']);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const TurnSchema = z.object({
  id: z.string(),
  speaker: SpeakerSchema,
  name: z.string(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  gloss: z.string().optional(),
});

export const CriterionSchema = z.object({
  id: z.enum(criterionIds),
  score: z.number().int().min(0).max(3).nullable(),
  reasoning: z.string(),
  evidence: z.array(
    z.object({
      quote: z.string(),
      timestamp: z.string(),
      speaker: SpeakerSchema,
      evidence_type: z.enum(['quote', 'absence']).default('quote'),
    }),
  ),
  verified: z.boolean().default(true),
  /** How the scoring runs compared. 'single' = one run (fast mode). Absent on records saved before consensus runs. */
  agreement: z.enum(['agree', '±1', 'disputed', 'single']).optional(),
  /** Each run's 0-3 score for this criterion (runs that marked it N/A are omitted). */
  runs: z.array(z.number()).optional(),
});

export const SEVERITIES = ['minor', 'major', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A moment in the call where the rep went wrong, as reported by the scoring model and checked against the transcript. */
export const MistakeSchema = z.object({
  timestamp: z.string(),
  /** Verbatim words from the transcript. Empty when only the line (not the exact words) could be located. */
  quote: z.string(),
  category: z.string(),
  severity: z.enum(SEVERITIES),
  what_went_wrong: z.string(),
  better_alternative: z.string(),
  /** Rubric criterion this mistake counts against, or '' when it is not tied to one. */
  criterion: z.string().default(''),
});
export type Mistake = z.infer<typeof MistakeSchema>;

/** Facts the scoring model read from the conversation that code cannot reliably count (Tanglish questions have no "?"). */
export const CallFactsSchema = z.object({
  rep_questions: z.number().int().min(0).nullable(),
  customer_questions: z.number().int().min(0).nullable(),
  next_step: z.object({ set: z.boolean().nullable(), detail: z.string(), timestamp: z.string() }),
  customer_sentiment: z.enum(['positive', 'neutral', 'negative', 'unknown']),
  outcome: z.string(),
});
export type CallFacts = z.infer<typeof CallFactsSchema>;

export const CostItemSchema = z.object({
  step: z.enum(['transcribe', 'thanglish', 'speakers', 'score']),
  label: z.string(),
  model: z.string(),
  seconds: z.number().optional(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  cost: z.number().nullable(),
  source: z.enum(['reported', 'estimated', 'unavailable']),
});
export type CostItem = z.infer<typeof CostItemSchema>;

export const AnalysisSchema = z.object({
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  pack_version: z.literal('1.0'),
  prompt_version: z.string(),
  models: z.record(z.string(), z.string()),
  product: z.string(),
  summary: z.string(),
  context_line: z.string(),
  rep: z.string(),
  customer: z.string(),
  call_type: z.string(),
  segment: z.string(),
  language: z.string(),
  duration: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
  transcript: z.array(TurnSchema),
  criteria: z.array(CriterionSchema),
  red_flags: z.array(z.object({ type: z.string(), quote: z.string(), timestamp: z.string() })),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  try_saying: z.string(),
  objections: z.array(
    z.object({
      type: z.string(),
      quote: z.string(),
      timestamp: z.string(),
      response: z.string(),
      verdict: z.string(),
      better_response: z.string(),
    }),
  ),
  /** Specific moments where the rep made a mistake. Empty for analyses saved before this field existed. */
  mistakes: z.array(MistakeSchema).default([]),
  /** Model-read call facts that feed the Analytics tab. Absent for older analyses. */
  call_facts: CallFactsSchema.optional(),
  /** Optional ISO date-times the user gave, used for the "Speed to lead" metric. */
  enquired_at: z.string().optional(),
  called_at: z.string().optional(),
  // Things the user should know about how this result was produced (dropped quotes, unlabeled speakers...).
  warnings: z.array(z.string()).default([]),
  // Itemised OpenRouter spend for this run. Empty for analyses saved before cost tracking existed.
  costs: z.array(CostItemSchema).default([]),
  // Per-step wall-clock timings in milliseconds. Empty for analyses saved before timing existed.
  timings: z.record(z.string(), z.number()).default({}),
  /**
   * Present only when the call was scored twice. `run_a` and `run_b` hold each run's 0-3 score per
   * criterion; `total_range` is the spread between the two runs' final totals.
   */
  double_run: z
    .object({
      run_a: z.record(z.string(), z.number().nullable()),
      run_b: z.record(z.string(), z.number().nullable()),
      /** Criterion ids where the two runs disagreed by more than one point. */
      disagreements: z.array(z.string()),
      total_range: z.number(),
    })
    .optional(),
  /** Stored score result. Optional so records saved before this field existed still parse. */
  score: z
    .object({
      total: z.number(),
      raw: z.number(),
      band: z.string(),
      coverage: z.number().min(0).max(1),
      provisional: z.boolean(),
      gate: z.object({ failed: z.boolean(), reason: z.string().optional() }),
      rubric_version: z.string(),
    })
    .optional(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;