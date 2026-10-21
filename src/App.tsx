import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, BarChart3, Download, FileAudio, History, Settings, Sparkles, Trash2, X } from 'lucide-react';
import type { Analysis } from './domain';
import { RUBRIC, groups } from './config/rubric';
import { defaultModels, type ModelSlots, type RouterModel } from './config/models';
import { isAbort, listModels, RouterError } from './lib/openrouter';
import { runAnalysis, STEP_LABELS, stepsFor, type StepId } from './lib/pipeline';
import { deleteAnalysis, listAnalyses, loadAudio, saveAnalysis, saveAudio } from './lib/history';
import { formatClock } from './lib/transcript';
import { computeAllMetrics, extrasOf, getMetricToggles, METRIC_HELP, METRIC_NAMES, type Metric, type MetricName } from './lib/metrics';
import { buildAnnotations, segmentLine, SEVERITY_LABEL, type Annotation } from './lib/mistakes';
import { getScore, type ScoreResult } from './lib/scoring';
import { buildDataJson, buildReportHtml, downloadFile, exportName } from './lib/export';
import { Dashboard, type TeamAnalysis } from './components/Dashboard';
import { getSession, getUserTeam, importLocalHistory, isSupabaseConfigured, listAnalyses as listTeamAnalyses, onAuthStateChange, signOut } from './lib/supabase';
import { AuthGate } from './components/AuthGate';
import { ApiKeyCard } from './components/ApiKeyCard';
import { getConnection, loadKey, setConnection, type Connection } from './lib/connection';
import { cacheSize, clearCache } from './lib/cache';

type Stage = 'input' | 'working' | 'result' | 'dashboard';
type Tab = 'feedback' | 'transcript' | 'analytics' | 'objections';
type Context = { repName: string; product: string; vocabulary: string; enquiredAt: string; calledAt: string };
type ProgressState = { step: StepId; detail?: string };

const TRANSCRIPTION_PRESETS = [
  { id: 'elevenlabs/scribe-v2', name: 'Scribe v2', detail: 'Best quality · native speaker labels · recommended' },
  { id: 'fish-audio/transcribe-1-pro', name: 'Fish Transcribe 1 Pro', detail: 'Conversation-focused · native speaker labels · experimental' },
  { id: 'microsoft/mai-transcribe-2', name: 'MAI Transcribe 2', detail: 'Lower cost · native speaker labels' },
  { id: 'microsoft/mai-transcribe-1.5', name: 'MAI Transcribe 1.5', detail: 'Legacy fallback · text only' },
] as const;

const modelName = 'callscore:models';
const languageName = 'callscore:language';
const metricTogglesName = 'callscore:metric-toggles';
const doubleScoreName = 'callscore:double-score';
const MAX_AUDIO_MB = 25;

// A model slot that was never chosen (or saved empty) falls back to the built-in default.
const withDefaultModels = (saved: Partial<ModelSlots>): ModelSlots => ({
  transcribe: saved.transcribe?.trim() || defaultModels.transcribe,
  understand: saved.understand?.trim() || defaultModels.understand,
  prep: saved.prep?.trim() || defaultModels.prep,
});

function getSettings() {
  try {
    return {
      key: loadKey(),
      models: withDefaultModels(JSON.parse(localStorage.getItem(modelName) ?? '{}') as Partial<ModelSlots>),
      language: localStorage.getItem(languageName) ?? '',
      metricToggles: getMetricToggles(JSON.parse(localStorage.getItem(metricTogglesName) ?? '{}') as Record<string, boolean>),
      doubleScore: localStorage.getItem(doubleScoreName) === 'true',
    };
  } catch {
    return { key: '', models: defaultModels, language: '', metricToggles: getMetricToggles(), doubleScore: false };
  }
}

function describeError(error: unknown) {
  if (isAbort(error)) return 'Analysis cancelled.';
  if (error instanceof RouterError) return error.status > 0 ? `${error.status}: ${error.message}` : error.message;
  if (error instanceof Error) return error.message;
  return 'Analysis failed.';
}

const srtClock = (seconds: number) => {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

/** Re-score the existing words with the two semantic roles reversed; no audio is uploaded or transcribed again. */
const transcriptWithSwappedRoles = (analysis: Analysis) =>
  analysis.transcript
    .map((turn, index) => {
      const label = turn.speaker === 'rep' ? 'Customer' : turn.speaker === 'customer' ? 'Rep' : turn.name;
      const end = Math.max(turn.end, turn.start + 0.1);
      return `${index + 1}\n${srtClock(turn.start)} --> ${srtClock(end)}\n${label}: ${turn.text}`;
    })
    .join('\n\n');

function useEscape(close: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
}

export function App() {
  const initial = getSettings();
  const [stage, setStage] = useState<Stage>('input');
  const [tab, setTab] = useState<Tab>('feedback');
  const [key, setKey] = useState(initial.key);
  const [models, setModels] = useState<ModelSlots>(initial.models);
  const [language, setLanguage] = useState(initial.language);
  const [metricToggles, setMetricToggles] = useState<Record<MetricName, boolean>>(initial.metricToggles);
  const [doubleScore, setDoubleScore] = useState(initial.doubleScore);
  const [settings, setSettings] = useState(false);
  const [file, setFile] = useState<File>();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'audio' | 'transcript'>('audio');
  const [context, setContext] = useState<Context>({ repName: '', product: '', vocabulary: '', enquiredAt: '', calledAt: '' });
  const [analysis, setAnalysis] = useState<Analysis>();
  const [steps, setSteps] = useState<StepId[]>(stepsFor(true));
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Analysis[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [abort, setAbort] = useState<AbortController>();
  // The transport is the user's explicit choice. Team server needs Supabase; a stored 'server' choice
  // without it is treated as direct (and corrected in storage below) so calls never go to a missing proxy.
  const supabaseReady = isSupabaseConfigured();
  const [connMode, setConnMode] = useState<Connection['mode']>(() => (supabaseReady ? getConnection().mode : 'direct'));
  const serverMode = connMode === 'server' && supabaseReady;
  const [signedIn, setSignedIn] = useState(false);
  const [checkingSession, setCheckingSession] = useState(serverMode);

  useEffect(() => {
    if (!supabaseReady && getConnection().mode === 'server') setConnection('direct');
  }, [supabaseReady]);

  // Sign-in only matters for the team server. Restore an existing session so a refresh does not force a new one.
  useEffect(() => {
    if (!serverMode) return;
    let live = true;
    getSession()
      .then((session) => {
        if (live) {
          setSignedIn(Boolean(session));
          setCheckingSession(false);
        }
      })
      .catch(() => {
        if (live) setCheckingSession(false);
      });
    return () => {
      live = false;
    };
  }, [serverMode]);

  const chooseConnection = (next: Connection['mode']) => {
    if (next === 'server' && !supabaseReady) return;
    setConnection(next);
    setConnMode(next);
    if (next === 'server') {
      setCheckingSession(true);
      setSettings(false);
    }
  };

  useEffect(() => {
    listAnalyses()
      .then((items) => setHistory(items.sort((a, b) => b.created_at.localeCompare(a.created_at))))
      .catch(() => undefined);
  }, []);

  const settingsDrawer = settings && (
    <SettingsDrawer
      close={() => setSettings(false)}
      apiKey={key}
      setKey={setKey}
      connection={serverMode ? 'server' : 'direct'}
      chooseConnection={chooseConnection}
      models={models}
      setModels={setModels}
      metricToggles={metricToggles}
      setMetricToggles={setMetricToggles}
      doubleScore={doubleScore}
      setDoubleScore={setDoubleScore}
      signedIn={signedIn}
      onSignedOut={() => {
        setSignedIn(false);
        setSettings(false);
      }}
    />
  );

  if (checkingSession && serverMode) {
    return (
      <main className="shell process">
        <h1>Checking your session…</h1>
      </main>
    );
  }

  // The sign-in gate belongs to the team server only; a direct key never needs an account.
  if (serverMode && !signedIn) {
    return (
      <>
        <Header settings={() => setSettings(true)} history={() => setShowHistory(true)} />
        <AuthGate onSignedIn={() => setSignedIn(true)} onUseKey={() => chooseConnection('direct')} />
        {settingsDrawer}
      </>
    );
  }

  const sourceReady = mode === 'audio' ? Boolean(file) : Boolean(text.trim());

  async function analyze() {
    if (!serverMode && !key.trim()) {
      setError('Add your OpenRouter key before analysing a call. Paste it in the key box on this page.');
      return;
    }
    const missing = [
      mode === 'audio' && !models.transcribe && 'a transcription model',
      !models.understand && 'an analysis model',
    ].filter(Boolean);
    if (missing.length) {
      setSettings(true);
      setError(`Open Settings and add ${missing.join(', ')}.`);
      return;
    }
    const controller = new AbortController();
    const audio = mode === 'audio' ? file : undefined;
    setAbort(controller);
    setError('');
    setProgress(null);
    setSteps(stepsFor(Boolean(audio)));
    setStage('working');
    try {
      const value = await runAnalysis({
        key,
        models,
        text: mode === 'transcript' ? text : '',
        audio,
        context,
        language,
        doubleScore,
        signal: controller.signal,
        onProgress: (step, detail) => setProgress({ step, detail }),
      });
      // Persisting is best-effort: a full disk or private-browsing mode must not discard a finished analysis.
      await saveAnalysis(value).catch(() => undefined);
      if (audio) await saveAudio(value.id, audio).catch(() => undefined);
      setAnalysis(value);
      setTab('feedback');
      setHistory((items) => [value, ...items]);
      setStage('result');
    } catch (e) {
      setError(describeError(e));
      setStage('input');
    } finally {
      setAbort(undefined);
    }
  }

  const load = (item: Analysis) => {
    setAnalysis(item);
    setTab('feedback');
    setStage('result');
    setShowHistory(false);
  };
  const remove = async (id: string) => {
    await deleteAnalysis(id).catch(() => undefined);
    setHistory((items) => items.filter((item) => item.id !== id));
  };
  const rescoreWithSwappedSpeakers = async () => {
    if (!analysis) return;
    const original = analysis;
    const controller = new AbortController();
    setAbort(controller);
    setError('');
    setProgress(null);
    setSteps(stepsFor(false));
    setStage('working');
    try {
      const value = await runAnalysis({
        key,
        models,
        text: transcriptWithSwappedRoles(original),
        context,
        language,
        doubleScore,
        signal: controller.signal,
        onProgress: (step, detail) => setProgress({ step, detail }),
      });
      value.warnings.unshift('Speaker roles were manually swapped and the scorecard was regenerated. The recording was not transcribed again.');
      await saveAnalysis(value).catch(() => undefined);
      const savedAudio = await loadAudio(original.id).catch(() => undefined);
      if (savedAudio) await saveAudio(value.id, savedAudio).catch(() => undefined);
      setAnalysis(value);
      setHistory((items) => [value, ...items]);
      setTab('feedback');
      setStage('result');
    } catch (e) {
      setError(describeError(e));
      setAnalysis(original);
      setStage('result');
    } finally {
      setAbort(undefined);
    }
  };

  return (
    <>
      <Header
        settings={() => setSettings(true)}
        history={() => setShowHistory(true)}
        dashboard={serverMode ? () => setStage('dashboard') : undefined}
      />
      {stage === 'dashboard' && <DashboardView close={() => setStage('input')} />}
      {stage === 'input' && (
        <Input
          apiKey={serverMode ? undefined : key}
          setApiKey={setKey}
          mode={mode}
          setMode={setMode}
          file={file}
          setFile={setFile}
          text={text}
          setText={setText}
          context={context}
          setContext={setContext}
          language={language}
          setLanguage={(value) => {
            setLanguage(value);
            localStorage.setItem(languageName, value);
          }}
          run={analyze}
          ready={sourceReady}
          error={error}
        />
      )}
      {stage === 'working' && <Processing steps={steps} progress={progress} cancel={() => abort?.abort()} />}
      {stage === 'result' && analysis && (
        <Results
          analysis={analysis}
          tab={tab}
          setTab={setTab}
          reset={() => {
            setFile(undefined);
            setText('');
            setStage('input');
          }}
          metricToggles={metricToggles}
          rescoreWithSwappedSpeakers={rescoreWithSwappedSpeakers}
          error={error}
        />
      )}
      {settingsDrawer}
      {showHistory && <HistoryDrawer items={history} load={load} remove={remove} close={() => setShowHistory(false)} />}
    </>
  );
}

function Header({ settings, history, dashboard }: { settings: () => void; history: () => void; dashboard?: () => void }) {
  return (
    <header>
      <button className="brand" onClick={dashboard ?? (() => location.reload())}>
        <i />
        CallScore
      </button>
      <nav>
        {dashboard && (
          <button onClick={dashboard}>
            <BarChart3 size={18} /> <span>Dashboard</span>
          </button>
        )}
        <button onClick={history}>
          <History size={18} /> <span>History</span>
        </button>
        <button onClick={settings}>
          <Settings size={18} /> <span>Settings</span>
        </button>
      </nav>
    </header>
  );
}

function Drawer({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  useEscape(close);
  return (
    <>
      <div className="backdrop" onClick={close} />
      <aside className="drawer" aria-modal="true" role="dialog" aria-label={title}>
        <div className="row between">
          <h2>{title}</h2>
          <button className="icon" onClick={close} aria-label={`Close ${title}`}>
            <X />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

const AUDIO_NAME = /\.(mp3|m4a|wav|ogg|oga|opus|webm|flac|aac|mp4)$/i;

function Input({
  apiKey, setApiKey, mode, setMode, file, setFile, text, setText, context, setContext, language, setLanguage, run, ready, error,
}: {
  /** The saved direct-mode key, or undefined on the team server (no key is needed there). */
  apiKey?: string;
  setApiKey: (x: string) => void;
  mode: 'audio' | 'transcript';
  setMode: (x: 'audio' | 'transcript') => void;
  file?: File;
  setFile: (x: File | undefined) => void;
  text: string;
  setText: (x: string) => void;
  context: Context;
  setContext: (x: Context) => void;
  language: string;
  setLanguage: (x: string) => void;
  run: () => void;
  ready: boolean;
  error: string;
}) {
  const [notice, setNotice] = useState('');
  // Once the card has been needed it stays for this visit, so it does not vanish while the key is being typed.
  const [keyNeeded, setKeyNeeded] = useState(apiKey === '');
  if (apiKey === '' && !keyNeeded) setKeyNeeded(true);
  const showKeyCard = apiKey !== undefined && (apiKey === '' || keyNeeded);

  const chooseAudio = (next?: File) => {
    setNotice('');
    if (!next) return;
    if (!next.type.startsWith('audio/') && !AUDIO_NAME.test(next.name)) return setNotice('That does not look like an audio file. Use MP3, M4A, WAV, OGG, WEBM, FLAC or AAC.');
    if (next.size > MAX_AUDIO_MB * 1024 * 1024) return setNotice(`That recording is ${(next.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_AUDIO_MB} MB; export it as MP3 to make it smaller.`);
    setFile(next);
  };
  const importText = async (next?: File) => {
    setNotice('');
    if (!next) return;
    if (next.size > 1024 * 1024) return setNotice('That transcript file is over 1 MB.');
    setText(await next.text());
  };

  return (
    <main className="shell upload">
      <section className="hero">
        <h1>Review the call. Coach the next one.</h1>
        <p>Upload one customer conversation. CallScore identifies the selling moments, applies the enabled inbound B2C rubric, and gives evidence you can revisit.</p>
        {showKeyCard && <ApiKeyCard apiKey={apiKey} onKeyChange={setApiKey} />}
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === 'audio'} className={mode === 'audio' ? 'active' : ''} onClick={() => setMode('audio')}>
            Audio recording
          </button>
          <button role="tab" aria-selected={mode === 'transcript'} className={mode === 'transcript' ? 'active' : ''} onClick={() => setMode('transcript')}>
            Transcript
          </button>
        </div>
        {mode === 'audio' ? (
          <label
            className="drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              chooseAudio(e.dataTransfer.files?.[0]);
            }}
          >
            <FileAudio size={30} />
            <b>{file ? file.name : 'Choose or drop an audio recording'}</b>
            <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ready to transcribe` : `MP3, M4A, WAV, OGG, WEBM, FLAC or AAC · up to ${MAX_AUDIO_MB} MB`}</span>
            <input
              type="file"
              accept="audio/*,.m4a,.flac,.aac,.opus"
              onChange={(e) => {
                chooseAudio(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        ) : (
          <>
            <textarea aria-label="Paste transcript" maxLength={200000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a conversation here. Speaker labels and SRT/VTT timestamps are optional." />
            <label className="fileline">
              Or import .txt, .srt or .vtt (up to 1 MB)
              <input
                type="file"
                accept=".txt,.srt,.vtt"
                onChange={(e) => {
                  void importText(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </>
        )}
        <details>
          <summary>Add context</summary>
          <div className="context">
            <input value={context.repName} onChange={(e) => setContext({ ...context, repName: e.target.value })} placeholder="Rep name (optional)" />
            <input value={context.product} onChange={(e) => setContext({ ...context, product: e.target.value })} placeholder="Product or plan hint (optional)" />
            <input value={context.vocabulary} onChange={(e) => setContext({ ...context, vocabulary: e.target.value })} placeholder="Vocabulary: product and Tamil business terms" />
            <label className="inline">
              Lead enquiry time (optional, for Speed to lead)
              <input type="datetime-local" value={context.enquiredAt} onChange={(e) => setContext({ ...context, enquiredAt: e.target.value })} />
            </label>
            <label className="inline">
              Time of this call (optional, for Speed to lead)
              <input type="datetime-local" value={context.calledAt} onChange={(e) => setContext({ ...context, calledAt: e.target.value })} />
            </label>
            {mode === 'audio' && (
              <label className="inline">
                Spoken language
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="">Auto-detect (recommended for Tanglish)</option>
                  <option value="ta">Tamil</option>
                  <option value="en">English</option>
                </select>
              </label>
            )}
          </div>
        </details>
        {(notice || error) && (
          <p className="error" role="alert">
            {notice || error}
          </p>
        )}
        <button className="primary" disabled={!ready} onClick={run}>
          <Sparkles size={18} /> Analyze call
        </button>
        <p className="privacy">Your call is stored locally in this browser. For live analysis it is sent to OpenRouter with your key; browser-held keys are for private/local use only.</p>
      </section>
    </main>
  );
}

const notes = [
  'Reading the conversation and keeping each statement in context.',
  'Matching evidence to the enabled sales rubric.',
  'Preparing practical coaching you can use on the next call.',
];

function Processing({ steps, progress, cancel }: { steps: StepId[]; progress: ProgressState | null; cancel: () => void }) {
  const [noteIndex, setNoteIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [stageTimes, setStageTimes] = useState<Partial<Record<StepId, number>>>({});
  const stageStarted = useRef<Partial<Record<StepId, number>>>({});
  const activeStep = useRef<StepId | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNoteIndex((i) => (i + 1) % notes.length), 2200);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const start = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      setElapsed(Math.round((now - start) / 1000));
      const active = activeStep.current;
      const stageStart = active ? stageStarted.current[active] : undefined;
      if (active && stageStart) setStageTimes((times) => ({ ...times, [active]: Math.floor((now - stageStart) / 1000) }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const next = progress?.step ?? null;
    const previous = activeStep.current;
    const now = Date.now();
    if (previous && previous !== next && stageStarted.current[previous]) {
      setStageTimes((times) => ({ ...times, [previous]: Math.floor((now - stageStarted.current[previous]!) / 1000) }));
    }
    if (next && !stageStarted.current[next]) {
      stageStarted.current[next] = now;
      setStageTimes((times) => ({ ...times, [next]: 0 }));
    }
    activeStep.current = next;
  }, [progress?.step]);
  const current = progress ? steps.indexOf(progress.step) : -1;
  const stageTime = (step: StepId) => stageTimes[step] === undefined ? null : formatClock(stageTimes[step]!);
  return (
    <main className="shell process">
      <h1>We're working through your call.</h1>
      <p aria-live="polite">{progress ? `${STEP_LABELS[progress.step]}${progress.detail ? ` — ${progress.detail}` : ''}` : notes[noteIndex]}</p>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'running' : 'queued';
        return (
          <div className={`step ${state}`} key={step}>
            <span>{state === 'done' ? '✓' : state === 'running' ? '…' : String(index + 1)}</span>
            <div>
              <b>{STEP_LABELS[step]}</b>
              <small>
                {state === 'running'
                  ? `${progress?.detail ?? 'In progress'} · ${stageTime(step) ?? '0:00'}`
                  : state === 'done'
                    ? stageTime(step) ? `Done · ${stageTime(step)}` : 'Skipped'
                    : 'Queued'}
              </small>
            </div>
          </div>
        );
      })}
      <p className="muted">Elapsed: {formatClock(elapsed)} · Long recordings are processed in one-minute parts, so this can take a few minutes.</p>
      <button className="text" onClick={cancel}>
        Cancel analysis
      </button>
    </main>
  );
}

function Results({ analysis, tab, setTab, reset, metricToggles, rescoreWithSwappedSpeakers, error }: { analysis: Analysis; tab: Tab; setTab: (x: Tab) => void; reset: () => void; metricToggles: Record<MetricName, boolean>; rescoreWithSwappedSpeakers: () => void; error: string }) {
  const score = useMemo(() => getScore(analysis), [analysis]);
  return (
    <main className="shell results">
      <section className="overview">
        <span className="metadata">
          {analysis.call_type} · {analysis.segment}
        </span>
        <h1>{analysis.title}</h1>
        <div className="people">
          <Chip label={analysis.rep} hint="Rep" />
          <span>↔</span>
          <Chip label={analysis.customer} hint="Customer" />
        </div>
        <p>{analysis.summary}</p>
        <p className="meta">
          {analysis.language} · {formatClock(analysis.duration)} · {analysis.product} · {analysis.confidence} confidence
        </p>
        <button className="primary" onClick={reset}>
          Analyze a new call
        </button>
        <div className="exportRow">
          <button className="secondary" onClick={() => downloadFile(exportName(analysis, 'html'), 'text/html', buildReportHtml(analysis))}>
            <Download size={15} /> Export report (scorecard + cost)
          </button>
          <button className="secondary" onClick={() => downloadFile(exportName(analysis, 'json'), 'application/json', buildDataJson(analysis))}>
            <Download size={15} /> Export data (JSON)
          </button>
        </div>
      </section>
      <div className="content">
        {error && <p className="error" role="alert">{error}</p>}
        <nav className="tabs" aria-label="Call results">
          {(['feedback', 'transcript', 'analytics', 'objections'] as Tab[]).map((x) => (
            <button className={tab === x ? 'active' : ''} onClick={() => setTab(x)} key={x}>
              {x}
            </button>
          ))}
        </nav>
        {tab === 'feedback' && <Feedback analysis={analysis} score={score} />}
        {tab === 'transcript' && <Transcript analysis={analysis} key={analysis.id} rescoreWithSwappedSpeakers={rescoreWithSwappedSpeakers} />}
        {tab === 'analytics' && <Analytics analysis={analysis} toggles={metricToggles} />}
        {tab === 'objections' && <Objections analysis={analysis} />}
      </div>
    </main>
  );
}

function Chip({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="chip">
      <i>{label[0] || '?'}</i>
      <b>{label}</b>
      <small>{hint}</small>
    </span>
  );
}

function Feedback({ analysis, score }: { analysis: Analysis; score: ScoreResult }) {
  return (
    <section>
      <article className="coach">
        <div className="scorebadge">{Math.round(score.total)}</div>
        <div>
          <h2>{score.band}</h2>
          <p>{score.compliance_status === 'FAIL' ? 'Compliance gate triggered — score capped at 50.' : 'Score based only on verified, applicable evidence.'}</p>
        </div>
      </article>
      {Object.keys(analysis.timings).length > 0 && (
        <article className="timings">
          <b>Step timings</b>
          {Object.entries(analysis.timings).map(([step, ms]) => (
            <p key={step}><span>{step}</span><span>{ms}ms</span></p>
          ))}
        </article>
      )}
      {analysis.double_run && analysis.double_run.disagreements.length > 0 && (
        <article className="disagreement" role="note">
          <b>Needs human review</b>
          <p>The two scoring runs disagreed by more than one point on:</p>
          {analysis.double_run.disagreements.map((id) => {
            const rubric = RUBRIC.criteria.find((x) => x.id === id);
            const a = analysis.double_run!.run_a[id];
            const b = analysis.double_run!.run_b[id];
            return (
              <p key={id}>
                {rubric?.name ?? id}: run A scored {a ?? '—'}/3, run B scored {b ?? '—'}/3
              </p>
            );
          })}
        </article>
      )}
      {analysis.warnings.length > 0 && (
        <article className="warnings" role="note">
          <b>Review notes</b>
          {analysis.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </article>
      )}
      <div className="twocol">
        <article>
          <h3>What went well</h3>
          {analysis.strengths.map((x) => (
            <p className="good" key={x}>✓ {x}</p>
          ))}
        </article>
        <article>
          <h3>What to improve</h3>
          {analysis.improvements.map((x) => (
            <p className="watch" key={x}>→ {x}</p>
          ))}
        </article>
      </div>
      <article className="try">
        <Sparkles size={18} />
        <div>
          <b>Try saying</b>
          <p>{analysis.try_saying}</p>
        </div>
      </article>
      <h2>Scorecard</h2>
      <div className="scoregroups">
        {groups.map(([name, ids]) => (
          <article className="group" key={name}>
            <div className="row between">
              <h3>{name}</h3>
              <span className="pill">0–6 points</span>
            </div>
            {ids.map((id) => {
              const rubric = RUBRIC.criteria.find((x) => x.id === id)!;
              const c = analysis.criteria.find((x) => x.id === id);
              return (
                <details className="criterion" key={id}>
                  <summary>
                    <span>{c?.score === null ? '—' : (c?.score ?? '?')}/3</span>
                    <b>{rubric.name}</b>
                    <small>Weight {rubric.weight}%</small>
                  </summary>
                  {c && !c.verified && <p className="unverified">No verifiable evidence — excluded from the total.</p>}
                  <p>{c?.reasoning}</p>
                  {c?.evidence.map((e, i) =>
                    e.evidence_type === 'absence' ? (
                      <p className="citation" key={i}>Not observed in the call.</p>
                    ) : (
                      <p className="citation" key={i}>[{e.timestamp}] “{e.quote}”</p>
                    ),
                  )}
                </details>
              );
            })}
          </article>
        ))}
      </div>
    </section>
  );
}

function Transcript({ analysis, rescoreWithSwappedSpeakers }: { analysis: Analysis; rescoreWithSwappedSpeakers: () => void }) {
  const [q, setQ] = useState('');
  const [src, setSrc] = useState<string>();
  const [showMistakes, setShowMistakes] = useState(true);
  const [showEvidence, setShowEvidence] = useState(false);
  const [flash, setFlash] = useState<string>();
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let live = true;
    let url: string | undefined;
    loadAudio(analysis.id)
      .then((blob) => {
        if (blob && live) {
          url = URL.createObjectURL(blob);
          setSrc(url);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [analysis.id]);

  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    void audio.play().catch(() => undefined);
  };

  const annotations = useMemo(() => buildAnnotations(analysis), [analysis]);
  const mistakes = annotations.filter((a) => a.kind === 'mistake');
  const visible = annotations.filter((a) => (a.kind === 'mistake' ? showMistakes : showEvidence));
  const byTurn = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    for (const a of visible) if (a.turnId !== undefined) map.set(a.turnId, [...(map.get(a.turnId) ?? []), a]);
    return map;
  }, [visible]);

  const jumpTo = (a: Annotation) => {
    if (a.turnId === undefined) return;
    setQ('');
    setFlash(a.turnId);
    window.setTimeout(() => setFlash(undefined), 1800);
    window.requestAnimationFrame(() => document.getElementById(`turn-${a.turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    const turn = analysis.transcript.find((t) => t.id === a.turnId);
    if (turn && src) seek(turn.start);
  };

  const shown = analysis.transcript.filter((t) => t.text.toLowerCase().includes(q.toLowerCase()));
  const counts = { critical: 0, major: 0, minor: 0 };
  for (const a of mistakes) counts[a.severity]++;

  return (
    <section>
      {src ? (
        <audio ref={audioRef} className="audio" controls src={src} />
      ) : (
        <p className="muted">The recording is not stored for this analysis, so playback is unavailable.</p>
      )}

      <article className="mistakeSummary" aria-label="Mistakes in this call">
        <div className="row between">
          <h2>
            <AlertTriangle size={18} aria-hidden="true" /> Mistakes in this call{mistakes.length ? ` (${mistakes.length})` : ''}
          </h2>
          <span className="muted">
            {counts.critical} critical · {counts.major} major · {counts.minor} minor
          </span>
        </div>
        {mistakes.length ? (
          <ol>
            {mistakes.map((a) => (
              <li key={a.id}>
                <button className={`sev-${a.severity}`} onClick={() => jumpTo(a)} disabled={a.turnId === undefined} title={a.turnId === undefined ? 'This moment could not be matched to a line' : 'Show this line in the transcript'}>
                  <span className="when">{a.timestamp || '—'}</span>
                  <span className={`sevtag sev-${a.severity}`}>{SEVERITY_LABEL[a.severity]}</span>
                  <b>{a.category}</b>
                  <span className="what">{a.what}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No mistakes were marked on this call.</p>
        )}
        <div className="legend">
          <label className="inline">
            <input type="checkbox" checked={showMistakes} onChange={(e) => setShowMistakes(e.target.checked)} /> Highlight mistakes
          </label>
          <label className="inline">
            <input type="checkbox" checked={showEvidence} onChange={(e) => setShowEvidence(e.target.checked)} /> Also show scoring evidence
          </label>
        </div>
      </article>

      <article>
        <div className="row between">
          <h2>Transcript</h2>
          <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transcript" aria-label="Search transcript" />
        </div>
        {analysis.transcript.some((turn) => turn.speaker === 'rep') && analysis.transcript.some((turn) => turn.speaker === 'customer') && (
          <div className="speakerCorrection">
            <span>Are the Rep and Customer labels reversed?</span>
            <button className="secondary" onClick={rescoreWithSwappedSpeakers}>Swap roles and re-score</button>
          </div>
        )}
        {shown.map((t) => {
          const marks = byTurn.get(t.id) ?? [];
          const worst = marks.find((m) => m.kind === 'mistake');
          const cls = ['bubble', t.speaker, src ? 'seekable' : '', worst ? `has-mistake sev-${worst.severity}` : marks.length ? 'has-evidence' : '', flash === t.id ? 'flash' : ''].filter(Boolean).join(' ');
          return (
            <div
              id={`turn-${t.id}`}
              className={cls}
              key={t.id}
              role={src ? 'button' : undefined}
              tabIndex={src ? 0 : undefined}
              onClick={src ? () => seek(t.start) : undefined}
              onKeyDown={src ? (e) => (e.key === 'Enter' || e.key === ' ') && seek(t.start) : undefined}
            >
              <small>
                {t.name} · {formatClock(t.start)}
              </small>
              <p className="transcript-line">
                {segmentLine(t.text, marks).map((segment, i) =>
                  segment.annotation ? (
                    <mark key={i} className={`hl ${segment.annotation.kind === 'mistake' ? `hl-${segment.annotation.severity}` : 'hl-evidence'}`} title={`${segment.annotation.category}: ${segment.annotation.what}`}>
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={i}>{segment.text}</span>
                  ),
                )}
              </p>
              {marks.map((m) => (
                <div className={`transcript-annotation ${m.kind === 'mistake' ? `mistake sev-${m.severity}` : 'evidence'}`} key={m.id}>
                  <b>
                    {m.kind === 'mistake' ? (
                      <>
                        <span className={`sevtag sev-${m.severity}`}>{SEVERITY_LABEL[m.severity]}</span> {m.category}
                      </>
                    ) : (
                      <>Evidence · {m.category}</>
                    )}
                  </b>
                  {m.what && (
                    <span>
                      {m.kind === 'mistake' && <em>What went wrong: </em>}
                      {m.what}
                    </span>
                  )}
                  {m.better && (
                    <span className="better">
                      <em>Try instead: </em>
                      {m.better}
                    </span>
                  )}
                </div>
              ))}
              {t.gloss && <small>{t.gloss}</small>}
            </div>
          );
        })}
      </article>
    </section>
  );
}

const SOURCE_LABEL: Record<NonNullable<Metric['source']>, string> = {
  measured: 'Measured',
  estimated: 'Estimated',
  ai: 'Read by AI',
  input: 'From your input',
};

function Analytics({ analysis, toggles }: { analysis: Analysis; toggles: Record<MetricName, boolean> }) {
  const data = useMemo(() => computeAllMetrics(analysis.transcript, analysis.duration, extrasOf(analysis)), [analysis]);
  const visible = METRIC_NAMES.filter((name) => toggles[name] !== false && data[name]);
  const unlabeled = !analysis.transcript.some((t) => t.speaker === 'rep') || !analysis.transcript.some((t) => t.speaker === 'customer');
  const scored = analysis.criteria.filter((c) => c.score !== null);
  return (
    <section>
      {unlabeled && (
        <p className="warnings" role="note">
          <b>Speakers were not identified for this call.</b> Metrics that depend on who said what are unavailable. Analyze the recording again to label the speakers.
        </p>
      )}
      <div className="metrics">
        {visible.map((name) => {
          const m = data[name];
          return (
            <article key={name}>
              <small>{name}</small>
              <h2>
                {m.approx && m.value !== '—' ? '≈ ' : ''}
                {m.value} <em>{m.unit}</em>
              </h2>
              <p className={m.status === 'n/a' ? 'na' : m.status}>● {m.status === 'n/a' ? 'not available' : m.status}</p>
              <small>{m.benchmark_text}</small>
              {m.note && <small className="metricNote">{m.note}</small>}
              {m.source && m.status !== 'n/a' && <small className="metricSource">{SOURCE_LABEL[m.source]}</small>}
            </article>
          );
        })}
      </div>
      {visible.length === 0 && <p className="muted">All metrics are switched off. Turn some on under Settings → Analytics metrics.</p>}
      {scored.length > 0 && (
        <article className="criteriaBars">
          <h2>Score by criterion</h2>
          {analysis.criteria.map((c) => {
            const rubric = RUBRIC.criteria.find((x) => x.id === c.id);
            return (
              <div className="barRow" key={c.id}>
                <span>{rubric?.name ?? c.id}</span>
                <div className="bar" role="img" aria-label={`${c.score ?? 'not assessed'} out of 3`}>
                  <i style={{ width: `${c.score === null ? 0 : (c.score / 3) * 100}%` }} className={c.score === null ? '' : c.score >= 2 ? 'good' : c.score === 1 ? 'watch' : 'poor'} />
                </div>
                <b>{c.score === null ? '—' : `${c.score}/3`}</b>
              </div>
            );
          })}
        </article>
      )}
    </section>
  );
}

function Objections({ analysis }: { analysis: Analysis }) {
  return (
    <section>
      {analysis.objections.length ? (
        analysis.objections.map((o, i) => (
          <article className="objection" key={`${o.timestamp}-${i}`}>
            <span className="tag">{o.type}</span>
            <p>
              <b>Customer · {o.timestamp}</b>
              <br />“{o.quote}”
            </p>
            <div>
              <b>Rep response</b>
              <p>“{o.response}”</p>
            </div>
            <p>
              <b>Better response:</b> {o.better_response}
            </p>
          </article>
        ))
      ) : (
        <article className="empty">
          <h2>No objections raised</h2>
          <p>The evaluator found no supported objection evidence in this call.</p>
        </article>
      )}
    </section>
  );
}

function ModelField({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (x: string) => void; options: RouterModel[]; placeholder: string }) {
  const id = `models-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <label>
      {label}
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      <datalist id={id}>
        {options.map((m) => (
          <option value={m.id} key={m.id}>
            {m.name || m.id}
          </option>
        ))}
      </datalist>
    </label>
  );
}

function SettingsDrawer({ close, apiKey, setKey, connection, chooseConnection, models, setModels, metricToggles, setMetricToggles, doubleScore, setDoubleScore, signedIn, onSignedOut }: { close: () => void; apiKey: string; setKey: (x: string) => void; connection: Connection['mode']; chooseConnection: (x: Connection['mode']) => void; models: ModelSlots; setModels: (x: ModelSlots) => void; metricToggles: Record<MetricName, boolean>; setMetricToggles: (x: Record<MetricName, boolean>) => void; doubleScore: boolean; setDoubleScore: (x: boolean) => void; signedIn: boolean; onSignedOut: () => void }) {
  const [cache, setCache] = useState<{ entries: number; bytes: number } | null>(null);
  const [cleared, setCleared] = useState('');
  const [draft, setDraft] = useState(models);
  const [textModels, setTextModels] = useState<RouterModel[]>([]);
  const [sttModels, setSttModels] = useState<RouterModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [toggles, setToggles] = useState(metricToggles);
  const [doubleRun, setDoubleRun] = useState(doubleScore);

  useEffect(() => {
    let live = true;
    cacheSize()
      .then((size) => live && setCache(size))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const wipeCache = async () => {
    await clearCache().catch(() => undefined);
    setCache({ entries: 0, bytes: 0 });
    setCleared('Cache cleared. The next analysis of a recording will be charged again.');
  };

  const load = async () => {
    const k = apiKey.trim();
    if (connection === 'direct' && !k) return setError('Enter an OpenRouter key first.');
    setBusy(true);
    setError('');
    setStatus('');
    const [text, stt] = await Promise.allSettled([listModels(k, 'text'), listModels(k, 'transcription')]);
    if (text.status === 'fulfilled') setTextModels(text.value);
    if (stt.status === 'fulfilled') setSttModels(stt.value);
    const problems = [text, stt].flatMap((r) => (r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : 'Could not load models.'] : []));
    if (problems.length) setError(problems[0]);
    else setStatus(`Loaded ${text.status === 'fulfilled' ? text.value.length : 0} analysis models and ${stt.status === 'fulfilled' ? stt.value.length : 0} transcription models.`);
    setBusy(false);
  };

  const save = () => {
    const next = { transcribe: draft.transcribe.trim(), understand: draft.understand.trim(), prep: draft.prep.trim() };
    // The key is not saved here: ApiKeyCard saves it as it is typed.
    localStorage.setItem(modelName, JSON.stringify(next));
    localStorage.setItem(metricTogglesName, JSON.stringify(toggles));
    localStorage.setItem(doubleScoreName, String(doubleRun));
    setModels(next);
    setMetricToggles(toggles);
    setDoubleScore(doubleRun);
    close();
  };

  return (
    <Drawer title="OpenRouter settings" close={close}>
      <h3>Connection</h3>
      <div className="seg compact" role="radiogroup" aria-label="Connection">
        <button role="radio" aria-checked={connection === 'direct'} className={connection === 'direct' ? 'active' : ''} onClick={() => chooseConnection('direct')}>
          Direct key
        </button>
        {isSupabaseConfigured() && (
          <button role="radio" aria-checked={connection === 'server'} className={connection === 'server' ? 'active' : ''} onClick={() => chooseConnection('server')}>
            Team server
          </button>
        )}
      </div>
      {connection === 'server' ? (
        <>
          <p className="notice">
            {signedIn
              ? 'Model calls go through your team’s analysis server, so no OpenRouter key is stored in this browser.'
              : 'Sign in to use your team’s analysis server.'}
          </p>
          {signedIn && (
            <button
              className="secondary"
              onClick={() => {
                void signOut();
                onSignedOut();
              }}
            >
              Sign out
            </button>
          )}
        </>
      ) : (
        <ApiKeyCard apiKey={apiKey} onKeyChange={setKey} />
      )}
      <button className="secondary" onClick={load} disabled={busy}>
        {busy ? 'Loading models…' : 'Load available models'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="hint">{status}</p>}
      <h3>Transcription engine</h3>
      <p className="muted">Choose a ready-to-use model now, or load the full OpenRouter list below. Your choice is saved when you click Save settings.</p>
      <div className="modelPresets" role="radiogroup" aria-label="Transcription model presets">
        {TRANSCRIPTION_PRESETS.map((preset) => (
          <button
            type="button"
            role="radio"
            aria-checked={draft.transcribe === preset.id}
            className={draft.transcribe === preset.id ? 'active' : ''}
            key={preset.id}
            onClick={() => setDraft({ ...draft, transcribe: preset.id })}
          >
            <b>{preset.name}</b>
            <small>{preset.detail}</small>
          </button>
        ))}
      </div>
      <ModelField label="Transcription model (audio → text)" value={draft.transcribe} onChange={(v) => setDraft({ ...draft, transcribe: v })} options={sttModels} placeholder="Load models, then pick one (e.g. a Whisper model)" />
      <ModelField label="Analysis model (scoring and coaching)" value={draft.understand} onChange={(v) => setDraft({ ...draft, understand: v })} options={textModels} placeholder="Load models, then pick one" />
      <ModelField label="Prep model (Thanglish + speakers)" value={draft.prep} onChange={(v) => setDraft({ ...draft, prep: v })} options={textModels} placeholder="Load models, then pick one" />
      <p className="muted">You can also type a model id directly or select any loaded model. The analysis model scores the call; the prep model handles Thanglish conversion and speaker-role mapping.</p>

      <h3>Cache</h3>
      <p className="muted">
        Transcripts and reports already produced in this browser are reused, so analysing the same
        recording twice does not cost money again.
        {cache ? ` Currently ${cache.entries} entr${cache.entries === 1 ? 'y' : 'ies'} (~${(cache.bytes / 1024).toFixed(0)} KB).` : ''}
      </p>
      <button className="secondary" onClick={wipeCache} disabled={!cache?.entries}>
        Clear cache
      </button>
      {cleared && <p className="hint">{cleared}</p>}

      <h3>Scoring reliability</h3>
      <label className="inline">
        <input type="checkbox" checked={doubleRun} onChange={(e) => setDoubleRun(e.target.checked)} />
        Score every call twice and flag disagreements (roughly doubles scoring cost)
      </label>

      <h3>Analytics metrics</h3>
      <p className="muted">Choose which metrics appear in the Analytics tab. All of them are always computed.</p>
      <div className="row">
        <button className="text" onClick={() => setToggles(Object.fromEntries(METRIC_NAMES.map((n) => [n, true])) as Record<MetricName, boolean>)}>Select all</button>
        <button className="text" onClick={() => setToggles(Object.fromEntries(METRIC_NAMES.map((n) => [n, false])) as Record<MetricName, boolean>)}>Clear all</button>
      </div>
      {METRIC_NAMES.map((name) => (
        <label className="metricToggle" key={name}>
          <input type="checkbox" checked={toggles[name]} onChange={(e) => setToggles({ ...toggles, [name]: e.target.checked })} />
          <span>
            <b>{name}</b>
            <small>{METRIC_HELP[name]}</small>
          </span>
        </label>
      ))}

      <button className="primary" onClick={save}>
        Save settings
      </button>
    </Drawer>
  );
}

function DashboardView({ close }: { close: () => void }) {
  const [analyses, setAnalyses] = useState<TeamAnalysis[]>([]);
  const [userName, setUserName] = useState('');
  const [role, setRole] = useState<string>('');
  const [teamName, setTeamName] = useState<string>('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [teamId, setTeamId] = useState<string>('');
  const [busy, setBusy] = useState(false);

  /** Fetch the signed-in user's membership and their team's analyses. Pure fetch, no state writes. */
  const fetchDashboard = async () => {
    const session = await getSession();
    if (!session) throw new Error('Sign in to view the team dashboard.');
    const membership = (await getUserTeam(session.user.id)) as { team_id?: string; role?: string; teams?: { name: string } } | null;
    if (!membership?.team_id) throw new Error('You are not a member of a team yet.');
    const rows = (await listTeamAnalyses(membership.team_id)) as TeamAnalysis[];
    return {
      teamId: membership.team_id,
      userName: session.user.email ?? 'Signed in',
      role: membership.role ?? 'rep',
      teamName: membership.teams?.name ?? '',
      rows,
    };
  };

  useEffect(() => {
    let live = true;
    fetchDashboard()
      .then((data) => {
        if (!live) return;
        setTeamId(data.teamId);
        setUserName(data.userName);
        setRole(data.role);
        setTeamName(data.teamName);
        setAnalyses(data.rows);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not load the dashboard.');
      });
    const unsubscribe = onAuthStateChange(() => undefined);
    return () => {
      live = false;
      unsubscribe?.data?.subscription?.unsubscribe();
    };
    }, []);

  const runImport = async () => {
    setBusy(true);
    setError('');
    setStatus('Reading this browser…');
    try {
      const local = await listAnalyses();
      if (!local.length) {
        setStatus('There is no saved history in this browser to import.');
        return;
      }
      const result = await importLocalHistory(teamId, local);
      setStatus(`Imported ${result.imported} call(s)${result.skipped ? `, skipped ${result.skipped} already present` : ''}${result.failed ? `, ${result.failed} failed` : ''}.`);
      setAnalyses((await fetchDashboard()).rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <div className="row between">
        <h1>Team dashboard</h1>
        <button className="secondary" onClick={close}>
          Back to analysis
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && <p className="hint">{status}</p>}
      {!error && (
        <Dashboard
          analyses={analyses}
          userName={`${userName}${teamName ? ` · ${teamName}` : ''}${role === 'manager' ? ' · manager' : ''}`}
          onImport={teamId ? runImport : undefined}
        />
      )}
      {busy && <p className="muted">Importing…</p>}
    </main>
  );
}

function HistoryDrawer({ items, load, remove, close }: { items: Analysis[]; load: (a: Analysis) => void; remove: (id: string) => void; close: () => void }) {
  return (
    <Drawer title="Saved analyses" close={close}>
      {items.length ? (
        items.map((a) => (
          <div className="historyRow" key={a.id}>
            <button className="historyItem" onClick={() => load(a)}>
              <b>{a.title}</b>
              <small>{new Date(a.created_at).toLocaleString()}</small>
            </button>
            <button className="icon" onClick={() => remove(a.id)} aria-label={`Delete ${a.title}`}>
              <Trash2 size={16} />
            </button>
          </div>
        ))
      ) : (
        <p>No saved analyses yet.</p>
      )}
    </Drawer>
  );
}
