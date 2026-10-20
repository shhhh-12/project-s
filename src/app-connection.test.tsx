import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// Supabase is configured here, which is exactly when a session used to flip the transport on its own.
const supabase = vi.hoisted(() => ({ configured: true }));
vi.mock('./lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/supabase')>();
  return {
    ...actual,
    isSupabaseConfigured: () => supabase.configured,
    getSession: async () => null,
    getUserTeam: async () => null,
    listAnalyses: async () => [],
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    signOut: async () => undefined,
  };
});

const original = globalThis.fetch;
beforeEach(() => {
  supabase.configured = true;
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});

const openSettings = () => fireEvent.click(screen.getByRole('button', { name: /Settings/ }));

describe('connection choice in the app', () => {
  it('does not show the sign-in gate in direct mode, even when Supabase is configured', () => {
    render(<App />);
    expect(screen.getByText(/Analyze call/i)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to analyse a call/i)).toBeNull();
  });

  it('shows the sign-in gate only after the team server is chosen', async () => {
    localStorage.setItem('callscore:mode', 'server');
    render(<App />);
    expect(await screen.findByText(/Sign in to analyse a call/i)).toBeInTheDocument();
  });

  it('lets someone stuck at the gate switch back to their own key', async () => {
    localStorage.setItem('callscore:mode', 'server');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Use your own OpenRouter key/ }));
    expect(await screen.findByText(/Analyze call/i)).toBeInTheDocument();
    expect(localStorage.getItem('callscore:mode')).toBe('direct');
  });

  it('treats a stored server choice as direct when Supabase is not configured, and corrects it', () => {
    supabase.configured = false;
    localStorage.setItem('callscore:mode', 'server');
    render(<App />);
    expect(screen.getByText(/Analyze call/i)).toBeInTheDocument();
    expect(localStorage.getItem('callscore:mode')).toBe('direct');
  });

  it('shows the key card on the main screen only while no key is saved', () => {
    const first = render(<App />);
    expect(screen.getByLabelText('OpenRouter API key')).toBeInTheDocument();
    first.unmount();
    sessionStorage.setItem('callscore:openrouter-key', 'sk-or-saved');
    render(<App />);
    expect(screen.queryByLabelText('OpenRouter API key')).toBeNull();
  });

  it('keeps the key card on screen while the first key is being typed', () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('OpenRouter API key'), { target: { value: 'sk-or-new' } });
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('sk-or-new');
  });

  it('blocks analysis in direct mode with no key, without calling OpenRouter', () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(url);
      return new Response('{}');
    }) as typeof fetch;
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    fireEvent.change(screen.getByLabelText('Paste transcript'), { target: { value: 'Agent: Hello\nCustomer: Hi' } });
    fireEvent.click(screen.getByRole('button', { name: /Analyze call/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Add your OpenRouter key/);
    expect(calls).toHaveLength(0);
  });

  it('offers the same key card and a Team server option in Settings', () => {
    sessionStorage.setItem('callscore:openrouter-key', 'sk-or-saved');
    render(<App />);
    openSettings();
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('sk-or-saved');
    expect(screen.getByRole('radio', { name: 'Direct key' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Team server' })).toBeInTheDocument();
  });

  it('hides the Team server option when Supabase is not configured', () => {
    supabase.configured = false;
    render(<App />);
    openSettings();
    expect(screen.getByRole('radio', { name: 'Direct key' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Team server' })).toBeNull();
  });

  it('saves the chosen mode when switching to Team server in Settings', async () => {
    render(<App />);
    openSettings();
    fireEvent.click(screen.getByRole('radio', { name: 'Team server' }));
    expect(localStorage.getItem('callscore:mode')).toBe('server');
    expect(await screen.findByText(/Sign in to analyse a call/i)).toBeInTheDocument();
  });
});
