import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MIN_QUERY_LENGTH,
  RECENT_CACHE_SIZE,
  SAFETY_THRESHOLDS,
  SEARCH_DEBOUNCE_MS,
  safetyLevelFor,
  safetyWarningsFor,
  useDebouncedValue,
  useTokenSearch,
  type TokenSearchResult,
} from './useTokenSearch';

function token(overrides: Partial<TokenSearchResult> = {}): TokenSearchResult {
  return {
    address: '0xabc',
    symbol: 'GOOD',
    name: 'Good Token',
    liquidityUsd: 500_000,
    volume24hUsd: 250_000,
    pairAgeHours: 800,
    isHoneypot: false,
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('safetyLevelFor', () => {
  it('rates a healthy token as safe', () => {
    expect(safetyLevelFor(token())).toBe('safe');
  });

  it('rates one failing metric as caution', () => {
    expect(safetyLevelFor(token({ liquidityUsd: 1 }))).toBe('caution');
    expect(safetyLevelFor(token({ volume24hUsd: 1 }))).toBe('caution');
    expect(safetyLevelFor(token({ pairAgeHours: 1 }))).toBe('caution');
  });

  it('rates two or more failing metrics as danger', () => {
    expect(safetyLevelFor(token({ liquidityUsd: 1, volume24hUsd: 1 }))).toBe('danger');
  });

  // The scam this check exists for looks healthy on every other metric, so a
  // honeypot flag must outrank them all.
  it('rates a honeypot as danger however good the other numbers look', () => {
    expect(
      safetyLevelFor(
        token({ isHoneypot: true, liquidityUsd: 10_000_000, volume24hUsd: 9_000_000 }),
      ),
    ).toBe('danger');
  });

  it('uses the documented thresholds as the boundary', () => {
    expect(safetyLevelFor(token({ liquidityUsd: SAFETY_THRESHOLDS.minLiquidityUsd }))).toBe('safe');
    expect(safetyLevelFor(token({ liquidityUsd: SAFETY_THRESHOLDS.minLiquidityUsd - 1 }))).toBe(
      'caution',
    );
  });
});

describe('safetyWarningsFor', () => {
  it('gives no warnings for a healthy token', () => {
    expect(safetyWarningsFor(token())).toEqual([]);
  });

  it('names each failing metric', () => {
    const warnings = safetyWarningsFor(
      token({ liquidityUsd: 1, volume24hUsd: 1, pairAgeHours: 1 }),
    );

    expect(warnings.join(' ')).toContain('liquidity');
    expect(warnings.join(' ')).toContain('volume');
    expect(warnings.join(' ')).toContain('Newly created');
  });

  it('leads with the honeypot warning and explains it', () => {
    expect(safetyWarningsFor(token({ isHoneypot: true }))[0]).toContain('may not be able to sell');
  });

  it('passes through warnings from upstream', () => {
    expect(safetyWarningsFor(token({ warnings: ['Mintable supply'] }))).toContain(
      'Mintable supply',
    );
  });
});

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles only after the delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'ab' });
    expect(result.current).toBe('a');

    act(() => void vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe('ab');
  });

  // Without the cleanup this would emit every intermediate value on a delay
  // rather than only the final one.
  it('emits only the last value in a burst of changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'a' },
    });

    for (const value of ['ab', 'abc', 'abcd']) {
      rerender({ value });
      act(() => void vi.advanceTimersByTime(100));
    }

    expect(result.current).toBe('a');

    act(() => void vi.advanceTimersByTime(300));
    expect(result.current).toBe('abcd');
  });
});

describe('useTokenSearch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockResponse(body: unknown, ok = true, status = 200) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok,
      status,
      json: async () => body,
    });
  }

  it('does not search until the query is long enough', async () => {
    mockResponse({ results: [token()] });

    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    act(() => result.current.setQuery('a'));

    await waitFor(() => expect(result.current.debouncedQuery).toBe('a'));

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(MIN_QUERY_LENGTH).toBe(2);
  });

  it('searches once the query settles and returns results', async () => {
    mockResponse({ results: [token()] });

    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    act(() => result.current.setQuery('good'));

    await waitFor(() => expect(result.current.results).toHaveLength(1));

    expect(result.current.results[0].symbol).toBe('GOOD');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends the query url-encoded', async () => {
    mockResponse({ results: [] });

    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    act(() => result.current.setQuery('a b&c'));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/tokens/search?q=a%20b%26c');
  });

  // A backend that returns a bare array should still render rather than
  // failing on a missing `.results`.
  it('accepts a bare array response as well as the wrapper', async () => {
    mockResponse([token({ symbol: 'BARE' })]);

    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    act(() => result.current.setQuery('bare'));

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.results[0].symbol).toBe('BARE');
  });

  it('surfaces a failed request as an error', async () => {
    mockResponse({}, false, 503);

    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    act(() => result.current.setQuery('boom'));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain('503');
  });

  it('reports the DexScreener fallback when the backend used it', async () => {
    mockResponse({ results: [token()], usedFallback: true });

    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    act(() => result.current.setQuery('fall'));

    await waitFor(() => expect(result.current.usedFallback).toBe(true));
  });

  it('retains recent result sets, most recent first', async () => {
    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    mockResponse({ results: [token({ symbol: 'ONE' })] });
    act(() => result.current.setQuery('one'));
    await waitFor(() => expect(result.current.results[0]?.symbol).toBe('ONE'));

    mockResponse({ results: [token({ symbol: 'TWO' })] });
    act(() => result.current.setQuery('two'));
    await waitFor(() => expect(result.current.results[0]?.symbol).toBe('TWO'));

    await waitFor(() => expect(result.current.recent.length).toBe(2));
    expect(result.current.recent[0].query).toBe('two');
    expect(result.current.recent[1].query).toBe('one');
  });

  it('caps the recent cache', async () => {
    const { result } = renderHook(() => useTokenSearch(), { wrapper });

    for (let i = 0; i < RECENT_CACHE_SIZE + 2; i += 1) {
      mockResponse({ results: [token({ symbol: `T${i}` })] });
      act(() => result.current.setQuery(`query${i}`));
      await waitFor(() => expect(result.current.results[0]?.symbol).toBe(`T${i}`));
    }

    await waitFor(() => expect(result.current.recent.length).toBe(RECENT_CACHE_SIZE));
  }, 15000);

  it('exposes the configured debounce interval', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });
});
