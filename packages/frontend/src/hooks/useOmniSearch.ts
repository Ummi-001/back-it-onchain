'use client';

import * as React from 'react';

export type OmniResultType = 'user' | 'call' | 'token' | 'tag' | 'category' | 'staker';

export interface OmniResult {
  id: string;
  type: OmniResultType;
  label: string;
  sublabel?: string;
  href: string;
  score: number;
}

export interface UseOmniSearchOptions {
  fetchResults?: (query: string, signal?: AbortSignal) => Promise<OmniResult[]>;
  debounceMs?: number;
  minLength?: number;
  enabled?: boolean;
}

const RECENT_KEY = 'backit-omnibox-recent-v1';

function score(value: string, query: string): number {
  const text = value.toLowerCase();
  const needle = query.toLowerCase();
  if (text === needle) return 100;
  if (text.startsWith(needle)) return 80;
  if (text.includes(needle)) return 60;
  let cursor = 0;
  for (const character of text) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return 30;
  }
  return 0;
}

function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

async function defaultFetch(query: string, signal?: AbortSignal): Promise<OmniResult[]> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  const body = await response.json() as { users?: Array<Record<string, unknown>>; calls?: Array<Record<string, unknown>>; tokens?: Array<Record<string, unknown>> };
  const results: OmniResult[] = [];
  for (const user of body.users || []) {
    const wallet = String(user.wallet || user.address || user.id || '');
    if (!wallet) continue;
    const label = String(user.displayName || user.handle || wallet);
    results.push({ id: wallet, type: 'user', label, sublabel: user.handle ? `@${String(user.handle)}` : wallet, href: `/profile/${wallet}`, score: score(label, query) });
  }
  for (const call of body.calls || []) {
    const id = String(call.callOnchainId || call.id || '');
    if (!id) continue;
    const condition = call.conditionJson as { title?: unknown } | undefined;
    const label = String(call.title || condition?.title || `Call #${id}`);
    results.push({ id, type: 'call', label, sublabel: String(call.asset || 'Prediction market'), href: `/calls/${id}`, score: score(label, query) });
  }
  for (const token of body.tokens || []) {
    const symbol = String(token.symbol || token.address || '');
    if (!symbol) continue;
    results.push({ id: symbol, type: 'token', label: String(token.name || symbol), sublabel: symbol, href: `/explore?token=${encodeURIComponent(symbol)}`, score: score(String(token.name || symbol), query) + score(symbol, query) });
  }
  return results.filter((result) => result.score > 0).sort((a, b) => b.score - a.score);
}

export function useOmniSearch(query: string, options: UseOmniSearchOptions = {}) {
  const { fetchResults = defaultFetch, debounceMs = 180, minLength = 1, enabled = true } = options;
  const [debounced, setDebounced] = React.useState(query.trim());
  const [results, setResults] = React.useState<OmniResult[]>([]);
  const [recent, setRecent] = React.useState<string[]>(readRecent);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, query]);

  React.useEffect(() => {
    if (!enabled || debounced.length < minLength) {
      setResults([]);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    fetchResults(debounced, controller.signal).then((next) => {
      setResults(next);
      setRecent((current) => {
        const updated = [debounced, ...current.filter((entry) => entry !== debounced)].slice(0, 8);
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
        return updated;
      });
    }).catch((caught) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error(String(caught)));
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [debounced, enabled, fetchResults, minLength]);

  return { query: debounced, results, recent, isLoading, error, clearRecent: () => { setRecent([]); window.localStorage.removeItem(RECENT_KEY); } };
}
