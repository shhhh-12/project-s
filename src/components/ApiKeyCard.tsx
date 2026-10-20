import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { forgetKey, isKeyRemembered, saveKey } from '../lib/connection';
import { isAbort, validateKey } from '../lib/openrouter';

type Check = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; text: string } | { state: 'error'; text: string };

/**
 * The one place an OpenRouter key is entered, tested and forgotten. It saves as you type (to this tab,
 * or to this device when "Remember" is ticked) and reports the trimmed key through `onKeyChange`.
 * Used on the main screen and in Settings so the two never drift apart.
 */
export function ApiKeyCard({ apiKey, onKeyChange }: { apiKey: string; onKeyChange: (key: string) => void }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const [remember, setRemember] = useState(isKeyRemembered);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const running = useRef<AbortController | null>(null);

  const cancel = () => {
    running.current?.abort();
    running.current = null;
  };
  useEffect(() => cancel, []);

  const change = (value: string) => {
    const next = value.trim();
    cancel();
    setCheck({ state: 'idle' });
    saveKey(next, remember);
    onKeyChange(next);
  };

  const toggleRemember = (value: boolean) => {
    setRemember(value);
    if (apiKey) saveKey(apiKey, value);
  };

  const forget = () => {
    cancel();
    forgetKey();
    setRemember(false);
    setCheck({ state: 'idle' });
    onKeyChange('');
  };

  const test = async () => {
    cancel();
    const controller = new AbortController();
    running.current = controller;
    setCheck({ state: 'testing' });
    try {
      const info = await validateKey(apiKey, controller.signal);
      if (controller.signal.aborted) return;
      setCheck({ state: 'ok', text: info.remaining === null ? '✓ Valid · no spending limit' : `✓ Valid · $${Math.max(info.remaining, 0).toFixed(2)} left` });
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) return;
      setCheck({ state: 'error', text: error instanceof Error ? error.message : 'Could not check the key. Try again.' });
    }
  };

  const odd = apiKey !== '' && !apiKey.startsWith('sk-or-');

  return (
    <div className="keycard">
      <label htmlFor={id}>OpenRouter API key</label>
      <div className="keyrow">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => change(e.target.value)}
          placeholder="sk-or-…"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-help`}
        />
        <button type="button" className="reveal" onClick={() => setShown(!shown)} aria-label={shown ? 'Hide key' : 'Show key'} aria-pressed={shown}>
          {shown ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      <p className="muted" id={`${id}-help`}>
        Sent only to OpenRouter. Kept in this tab until you close it, or on this device if you tick Remember.
      </p>
      {odd && <p className="notice">This does not look like an OpenRouter key (they start with sk-or-). You can still try it.</p>}
      <div className="keyactions">
        <button type="button" className="secondary" onClick={test} disabled={!apiKey || check.state === 'testing'}>
          {check.state === 'testing' ? 'Testing…' : 'Test key'}
        </button>
        <button type="button" className="text" onClick={forget} disabled={!apiKey}>
          Forget key
        </button>
      </div>
      <label className="inline">
        <input type="checkbox" checked={remember} onChange={(e) => toggleRemember(e.target.checked)} />
        Remember on this device
      </label>
      {check.state === 'ok' && <p className="hint" role="status">{check.text}</p>}
      {check.state === 'error' && <p className="error" role="alert">{check.text}</p>}
    </div>
  );
}
