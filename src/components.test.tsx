import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// The auth gate only appears when Supabase env vars are present; tests cover the browser-only path.
vi.mock('./lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/supabase')>();
  return {
    ...actual,
    isSupabaseConfigured: () => false,
    getSession: async () => null,
    getUserTeam: async () => null,
    listAnalyses: async () => [],
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    signOut: async () => undefined,
  };
});

afterEach(() => {
  localStorage.clear();
});

describe('app', () => {
  it('shows the real upload state', () => {
    render(<App />);
    expect(screen.getByText(/Analyze call/i)).toBeInTheDocument();
  });

  it('offers saved transcription model presets in Settings', () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('button', { name: /settings/i }).at(-1)!);
    expect(screen.getByRole('radiogroup', { name: /transcription model presets/i })).toBeInTheDocument();
    const scribe = screen.getByRole('radio', { name: /scribe v2/i });
    expect(scribe).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /mai transcribe 2/i }));
    expect(screen.getByRole('radio', { name: /mai transcribe 2/i })).toHaveAttribute('aria-checked', 'true');
  });
});
