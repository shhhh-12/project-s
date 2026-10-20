import { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import { RUBRIC } from '../config/rubric';

export type TeamAnalysis = {
  id: string;
  title: string;
  created_at: string;
  score_total: number | null;
  score_band: string | null;
  criteria: Array<{ id: string; score: number | null }> | null;
  teams?: { name: string };
};

export function Dashboard({ analyses, userName, onImport }: { analyses: TeamAnalysis[]; userName: string; onImport?: () => void }) {
  const [filterRep, setFilterRep] = useState<string>('all');
  const [dateRange, setDateRange] = useState<string>('all');
  // Captured once per mount so the cutoff is stable across renders.
  const [mountedAt] = useState(() => Date.now());

  const filtered = useMemo(() => {
    let items = analyses;
    if (filterRep !== 'all') items = items.filter((a) => a.id === filterRep);
    if (dateRange !== 'all') {
      const days = parseInt(dateRange, 10);
      const cutoff = mountedAt - days * 86400000;
      items = items.filter((a) => new Date(a.created_at).getTime() >= cutoff);
    }
    return items;
  }, [analyses, filterRep, dateRange, mountedAt]);

  const repStats = useMemo(() => {
    const stats = new Map<string, { total: number; count: number; avgScore: number; calls: TeamAnalysis[] }>();
    for (const a of filtered) {
      const key = a.id;
      const entry = stats.get(key) ?? { total: 0, count: 0, avgScore: 0, calls: [] };
      entry.count++;
      entry.calls.push(a);
      stats.set(key, entry);
    }
    for (const [, entry] of stats) {
      const scored = entry.calls.filter((c) => c.score_total !== null);
      entry.avgScore = scored.length ? scored.reduce((s, c) => s + (c.score_total ?? 0), 0) / scored.length : 0;
    }
    return stats;
  }, [filtered]);

  const criterionHeatmap = useMemo(() => {
    const map = new Map<string, Map<string, { total: number; count: number }>>();
    for (const a of filtered) {
      if (!a.criteria) continue;
      for (const c of a.criteria) {
        if (c.score === null) continue;
        let repMap = map.get(a.id);
        if (!repMap) { repMap = new Map(); map.set(a.id, repMap); }
        const entry = repMap.get(c.id) ?? { total: 0, count: 0 };
        entry.total += c.score;
        entry.count++;
        repMap.set(c.id, entry);
      }
    }
    return map;
  }, [filtered]);

  const sortedReps = useMemo(() => {
    return [...repStats.values()].sort((a, b) => b.avgScore - a.avgScore);
  }, [repStats]);

  return (
    <div className="dashboard">
      <h1>Team dashboard</h1>
      <p className="muted">Welcome, {userName}. View performance across your team.</p>

      <div className="filters">
        <label>
          Rep
          <select value={filterRep} onChange={(e) => setFilterRep(e.target.value)}>
            <option value="all">All reps</option>
            {[...repStats.keys()].map((id) => <option key={id} value={id}>{id.slice(0, 8)}</option>)}
          </select>
        </label>
        <label>
          Date range
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
            <option value="all">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        {onImport && (
          <button className="secondary" onClick={onImport} style={{ alignSelf: 'end' }}>
            <Upload size={15} /> Import this browser's history
          </button>
        )}
      </div>

      <section>
        <h2>Leaderboard</h2>
        {sortedReps.length ? (
          <table>
            <thead><tr><th>Rep</th><th>Calls</th><th>Avg score</th></tr></thead>
            <tbody>
              {sortedReps.map((stat, i) => (
                <tr key={i}>
                  <td>#{i + 1}</td>
                  <td>{stat.count}</td>
                  <td>{stat.avgScore > 0 ? stat.avgScore.toFixed(1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No analyses yet.</p>}
      </section>

      <section>
        <h2>Criterion heatmap</h2>
        <p className="muted">Average score per criterion per rep (0–3 scale).</p>
        {criterionHeatmap.size ? (
          <table>
            <thead><tr><th>Rep</th>{RUBRIC.criteria.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
            <tbody>
              {[...criterionHeatmap.entries()].map(([repId, criteria]) => (
                <tr key={repId}>
                  <td>{repId.slice(0, 8)}</td>
                  {RUBRIC.criteria.map((c) => {
                    const entry = criteria.get(c.id);
                    const avg = entry && entry.count > 0 ? entry.total / entry.count : null;
                    return <td key={c.id} className={avg === null ? 'na' : avg >= 2 ? 'good' : avg >= 1 ? 'watch' : 'poor'}>{avg !== null ? avg.toFixed(1) : '—'}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No criterion data yet.</p>}
      </section>

      <section>
        <h2>Recent calls</h2>
        {filtered.length ? (
          <table>
            <thead><tr><th>Title</th><th>Date</th><th>Score</th><th>Band</th></tr></thead>
            <tbody>
              {filtered.slice(0, 20).map((a) => (
                <tr key={a.id}>
                  <td>{a.title}</td>
                  <td>{new Date(a.created_at).toLocaleDateString()}</td>
                  <td>{a.score_total ?? '—'}</td>
                  <td>{a.score_band ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No calls in this period.</p>}
      </section>
    </div>
  );
}
