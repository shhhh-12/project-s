import type { Analysis } from '../domain';
import { RUBRIC } from '../config/rubric';
import { COST_STEP_LABELS, formatUsd, summarizeCosts } from './cost';
import { computeAllMetrics, extrasOf } from './metrics';
import { getScore } from './scoring';
import { formatClock } from './transcript';

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const criterionName = (id: string) => RUBRIC.criteria.find((c) => c.id === id)?.name ?? id;
const criterionWeight = (id: string) => RUBRIC.criteria.find((c) => c.id === id)?.weight ?? 0;
export const exportName = (analysis: Analysis, extension: string) =>
  `${(analysis.title || 'call').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'call'}-${analysis.created_at.slice(0, 10)}.${extension}`;

function costSection(analysis: Analysis) {
  if (!analysis.costs.length) return '<p class="muted">Cost was not recorded for this analysis (it was saved before cost tracking was added).</p>';
  const summary = summarizeCosts(analysis.costs);
  const notes = [
    summary.estimated ? `${summary.estimated} transcription line(s) are estimated from the model's published per-hour price because OpenRouter did not return the billed amount.` : '',
    summary.missing ? `${summary.missing} call(s) have no cost figure (n/a); the total excludes them.` : '',
    'Retried or unusable model responses that OpenRouter did not report back are not itemised.',
  ].filter(Boolean);
  return `<table><thead><tr><th>Where it was spent</th><th>Calls</th><th class="num">Cost (USD)</th></tr></thead><tbody>
${summary.steps.map((row) => `<tr><td>${esc(row.label)}</td><td>${row.calls}</td><td class="num">${formatUsd(row.cost)}</td></tr>`).join('\n')}
<tr class="total"><td>Total for this call</td><td>${analysis.costs.length}</td><td class="num">${formatUsd(summary.total)}</td></tr></tbody></table>
<h3>Every charge</h3>
<table><thead><tr><th>Step</th><th>Detail</th><th>Model</th><th>Usage</th><th>Basis</th><th class="num">Cost (USD)</th></tr></thead><tbody>
${analysis.costs
  .map((item) => {
    const usage = item.seconds !== undefined ? `${item.seconds}s of audio` : item.prompt_tokens !== undefined || item.completion_tokens !== undefined ? `${item.prompt_tokens ?? 0} in / ${item.completion_tokens ?? 0} out tokens` : '—';
    return `<tr><td>${esc(COST_STEP_LABELS[item.step])}</td><td>${esc(item.label)}</td><td>${esc(item.model)}</td><td>${esc(usage)}</td><td>${esc(item.source)}</td><td class="num">${formatUsd(item.cost)}</td></tr>`;
  })
  .join('\n')}
</tbody></table>
<ul class="muted">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`;
}

/** A self-contained, printable report: scorecard, coaching, objections, metrics, transcript and the cost of the run. */
export function buildReportHtml(analysis: Analysis) {
  const score = getScore(analysis);
  const stats = computeAllMetrics(analysis.transcript, analysis.duration, extrasOf(analysis));
  const list = (items: string[]) => (items.length ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(analysis.title)} · CallScore report</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#17202a;max-width:900px;margin:0 auto;padding:28px}
h1{margin:.2em 0}h2{margin:1.8em 0 .5em;border-bottom:2px solid #17202a;padding-bottom:4px}h3{margin:1.2em 0 .4em}
table{border-collapse:collapse;width:100%;margin:.5em 0}th,td{border:1px solid #c9d1d9;padding:6px 8px;text-align:left;vertical-align:top}th{background:#eef2f6}
.num{text-align:right;white-space:nowrap}.total td{font-weight:700;background:#eef2f6}.muted{color:#5b6773;font-size:12px}
.score{font-size:34px;font-weight:800}.fail{color:#b42318}.pass{color:#067647}blockquote{margin:.3em 0;padding-left:10px;border-left:3px solid #c9d1d9}
.turn{margin:.35em 0}.turn b{display:inline-block;min-width:150px}@media print{body{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>
<p class="muted">CallScore report · ${esc(analysis.call_type)} · ${esc(analysis.segment)} · created ${esc(new Date(analysis.created_at).toLocaleString())}</p>
<h1>${esc(analysis.title)}</h1>
<p>${esc(analysis.rep)} ↔ ${esc(analysis.customer)} · ${esc(analysis.language)} · ${formatClock(analysis.duration)} · ${esc(analysis.product)} · ${esc(analysis.confidence)} confidence</p>
<p>${esc(analysis.summary)}</p>
<h2>Scorecard</h2>
<p><span class="score">${score.total}</span> / 100 · <b>${esc(score.band)}</b> · compliance gate: <b class="${score.compliance_status === 'FAIL' ? 'fail' : 'pass'}">${score.compliance_status}</b>${score.raw !== score.total ? ` <span class="muted">(raw ${score.raw}, capped at 50)</span>` : ''}</p>
<table><thead><tr><th>Criterion</th><th class="num">Weight</th><th class="num">Score (0–3)</th><th>Reasoning and evidence</th></tr></thead><tbody>
${analysis.criteria
  .map(
    (c) => `<tr><td>${esc(criterionName(c.id))}</td><td class="num">${criterionWeight(c.id)}</td><td class="num">${c.score === null ? 'N/A' : c.score}${c.verified ? '' : '<br><span class="muted">excluded: no verified evidence</span>'}</td><td>${esc(c.reasoning)}${c.evidence
      .map((e) => (e.evidence_type === 'absence' ? '<blockquote class="muted">Not observed in the call</blockquote>' : `<blockquote>[${esc(e.timestamp)}] ${esc(e.speaker)}: “${esc(e.quote)}”</blockquote>`))
      .join('')}</td></tr>`,
  )
  .join('\n')}
</tbody></table>
<h2>Red flags</h2>
${analysis.red_flags.length ? `<ul>${analysis.red_flags.map((f) => `<li><b>${esc(f.type)}</b> [${esc(f.timestamp)}] “${esc(f.quote)}”</li>`).join('')}</ul>` : '<p class="muted">None found.</p>'}
<h2>Mistakes</h2>
${analysis.mistakes.length ? `<table><thead><tr><th>Time</th><th>Severity</th><th>What went wrong</th><th>Try instead</th></tr></thead><tbody>${analysis.mistakes.map((m) => `<tr><td class="num">${esc(m.timestamp)}</td><td>${esc(m.severity)}</td><td><b>${esc(m.category)}</b><br>${esc(m.what_went_wrong)}${m.quote ? `<blockquote>“${esc(m.quote)}”</blockquote>` : ''}</td><td>${esc(m.better_alternative || '—')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">None marked.</p>'}
<h2>Coaching</h2>
<h3>Strengths</h3>${list(analysis.strengths)}
<h3>Improvements</h3>${list(analysis.improvements)}
<h3>Try saying</h3><p>${esc(analysis.try_saying)}</p>
<h2>Objections</h2>
${analysis.objections.length ? analysis.objections.map((o) => `<h3>${esc(o.type)} · ${esc(o.verdict)}</h3><blockquote>[${esc(o.timestamp)}] Customer: “${esc(o.quote)}”</blockquote><blockquote>Rep: ${esc(o.response || '—')}</blockquote><p><b>Better response:</b> ${esc(o.better_response)}</p>`).join('') : '<p class="muted">No objections raised.</p>'}
<h2>Call metrics</h2>
<table><thead><tr><th>Metric</th><th>Value</th><th>Benchmark</th></tr></thead><tbody>${Object.entries(stats)
    .map(([name, m]) => `<tr><td>${esc(name)}</td><td>${esc(m.value)} ${esc(m.unit)}${m.note ? `<br><span class="muted">${esc(m.note)}</span>` : ''}</td><td>${esc(m.benchmark_text)}</td></tr>`)
    .join('')}</tbody></table>
${analysis.warnings.length ? `<h2>Review notes</h2>${list(analysis.warnings)}` : ''}
<h2>Cost of this analysis</h2>
${costSection(analysis)}
<h2>Models and versions</h2>
<ul>${Object.entries(analysis.models).map(([slot, id]) => `<li>${esc(slot)}: ${esc(id)}</li>`).join('')}<li>Knowledge pack ${esc(analysis.pack_version)} · prompt ${esc(analysis.prompt_version)}</li></ul>
${analysis.double_run ? `<h2>Double-scored review</h2><p>This call was scored twice. Total spread: <b>${analysis.double_run.total_range.toFixed(1)}</b> points.</p>${
    analysis.double_run.disagreements.length
      ? `<p class="muted">The two runs disagreed by more than one point on: ${esc(analysis.double_run.disagreements.map(criterionName).join(', '))}.</p><table><thead><tr><th>Criterion</th><th class="num">Run A</th><th class="num">Run B</th></tr></thead><tbody>${analysis.double_run.disagreements
          .map((id) => `<tr><td>${esc(criterionName(id))}</td><td class="num">${analysis.double_run!.run_a[id] ?? '—'}</td><td class="num">${analysis.double_run!.run_b[id] ?? '—'}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="muted">Both runs agreed on every criterion.</p>'
  }` : ''}
${Object.keys(analysis.timings).length > 0 ? `<h2>Step timings</h2><table><thead><tr><th>Step</th><th class="num">Duration (ms)</th></tr></thead><tbody>${Object.entries(analysis.timings).map(([step, ms]) => `<tr><td>${esc(step)}</td><td class="num">${ms}</td></tr>`).join('')}</tbody></table>` : ''}
<h2>Transcript</h2>
${analysis.transcript.map((t) => `<div class="turn"><b>[${formatClock(t.start)}] ${esc(t.name)}</b> ${esc(t.text)}</div>`).join('\n')}
</body></html>`;
}

export const buildDataJson = (analysis: Analysis) =>
  JSON.stringify({ ...analysis, score: getScore(analysis), cost_summary: summarizeCosts(analysis.costs) }, null, 2);

export function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
