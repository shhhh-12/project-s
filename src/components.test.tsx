import { render, screen } from '@testing-library/react';
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
});