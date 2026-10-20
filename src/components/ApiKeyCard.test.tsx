import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiKeyCard } from './ApiKeyCard';

const original = globalThis.fetch;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = original;
});

const NAME = 'callscore:openrouter-key';
const input = () => screen.getByLabelText('OpenRouter API key') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });

function Harness({ initial = '' }: { initial?: string }) {
  const [key, setKey] = useState(initial);
  return <ApiKeyCard apiKey={key} onKeyChange={setKey} />;
}

const reply = (status: number, json: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(json), { status })) as typeof fetch;
};

describe('ApiKeyCard', () => {
  it('trims whitespace and keeps the key in this tab only by default', () => {
    render(<Harness />);
    type('  sk-or-abc \n');
    expect(input().value).toBe('sk-or-abc');
    expect(sessionStorage.getItem(NAME)).toBe('sk-or-abc');
    expect(localStorage.getItem(NAME)).toBeNull();
  });

  it('masks the key until it is shown', () => {
    render(<Harness initial="sk-or-abc" />);
    expect(input().type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show key' }));
    expect(input().type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(input().type).toBe('password');
  });

  it('warns about an unfamiliar prefix but still saves the key', () => {
    render(<Harness />);
    type('abc123');
    expect(screen.getByText(/start with sk-or-/)).toBeInTheDocument();
    expect(sessionStorage.getItem(NAME)).toBe('abc123');
    type('sk-or-abc123');
    expect(screen.queryByText(/start with sk-or-/)).toBeNull();
  });

  it('moves the key to this device when Remember is ticked, and back when unticked', () => {
    render(<Harness initial="sk-or-abc" />);
    type('sk-or-abc');
    fireEvent.click(screen.getByLabelText('Remember on this device'));
    expect(localStorage.getItem(NAME)).toBe('sk-or-abc');
    expect(sessionStorage.getItem(NAME)).toBeNull();
    fireEvent.click(screen.getByLabelText('Remember on this device'));
    expect(sessionStorage.getItem(NAME)).toBe('sk-or-abc');
    expect(localStorage.getItem(NAME)).toBeNull();
  });

  it('starts with Remember ticked when the key was remembered earlier', () => {
    localStorage.setItem(NAME, 'sk-or-abc');
    render(<Harness initial="sk-or-abc" />);
    expect(screen.getByLabelText('Remember on this device')).toBeChecked();
  });

  it('forgets the key everywhere and clears the field', () => {
    localStorage.setItem(NAME, 'sk-or-abc');
    render(<Harness initial="sk-or-abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget key' }));
    expect(input().value).toBe('');
    expect(localStorage.getItem(NAME)).toBeNull();
    expect(sessionStorage.getItem(NAME)).toBeNull();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
  });

  it('shows how much credit is left for a valid key', async () => {
    reply(200, { data: { label: 'k', usage: 2.5, limit: 10 } });
    render(<Harness initial="sk-or-abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByText('✓ Valid · $7.50 left')).toBeInTheDocument();
  });

  it('says so when the key has no spending limit', async () => {
    reply(200, { data: { label: 'k', usage: 2.5, limit: null } });
    render(<Harness initial="sk-or-abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByText('✓ Valid · no spending limit')).toBeInTheDocument();
  });

  it('shows the friendly error for a rejected key', async () => {
    reply(401, { error: { message: 'No auth credentials found' } });
    render(<Harness initial="sk-or-bad" />);
    fireEvent.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('OpenRouter rejected the API key');
  });

  it('drops a stale result when the key is edited after testing', async () => {
    reply(200, { data: { label: 'k', usage: 0, limit: 5 } });
    render(<Harness initial="sk-or-abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Test key' }));
    await screen.findByText(/Valid/);
    type('sk-or-abcd');
    await waitFor(() => expect(screen.queryByText(/Valid/)).toBeNull());
  });
});
