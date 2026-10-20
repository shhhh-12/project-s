import { useState } from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import { signIn, signUp } from '../lib/supabase';

type Mode = 'signin' | 'signup';

/**
 * Sign-in gate used when Supabase is configured. Authentication here is what lets the browser
 * call the `openrouter-proxy` Edge Function, which is where the OpenRouter key lives.
 */
export function AuthGate({ onSignedIn, onUseKey }: { onSignedIn: () => void; onUseKey?: () => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return setError('Enter an email address and a password.');
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
        onSignedIn();
      } else {
        const result = await signUp(email.trim(), password);
        // Supabase may require email confirmation before a session exists.
        if (result.session) onSignedIn();
        else setNotice('Account created. Check your email to confirm the address, then sign in.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell upload">
      <section className="hero">
        <h1>Sign in to analyse a call.</h1>
        <p>Your team's calls and results are stored on your own server. Signing in is what lets this app reach the analysis service — the model key never reaches your browser.</p>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'active' : ''} onClick={() => { setMode('signin'); setError(''); setNotice(''); }}>
            Sign in
          </button>
          <button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); setNotice(''); }}>
            Create account
          </button>
        </div>
        <form onSubmit={submit} className="authform">
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={6} required />
          </label>
          {(error || notice) && (
            <p className={error ? 'error' : 'hint'} role={error ? 'alert' : undefined}>
              {error || notice}
            </p>
          )}
          <button className="primary" type="submit" disabled={busy}>
            {mode === 'signin' ? <LogIn size={18} /> : <UserPlus size={18} />}
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="privacy">New here? Create an account, then add your team in the dashboard.</p>
        {onUseKey && (
          <p className="privacy">
            No team account? <button type="button" className="text" onClick={onUseKey}>Use your own OpenRouter key instead</button>
          </p>
        )}
      </section>
    </main>
  );
}