import { describe, it, expect } from 'vitest';
import { buildMockAnalytics } from './useAnalytics';

describe('buildMockAnalytics', () => {
  it('is deterministic for a given wallet', () => {
    const a = buildMockAnalytics('0xabc');
    const b = buildMockAnalytics('0xabc');
    // Check deterministic values (reputation values, accuracy prices, pnl prices)
    // Timestamps use Date.now() so they differ between calls
    expect(a.reputation).toEqual(b.reputation);
    expect(a.accuracy.map(p => p.price)).toEqual(b.accuracy.map(p => p.price));
    expect(a.pnl.map(p => p.price)).toEqual(b.pnl.map(p => p.price));
    expect(a.stakingVolume).toEqual(b.stakingVolume);
  });

  it('produces different data for different wallets', () => {
    const a = buildMockAnalytics('0xabc');
    const b = buildMockAnalytics('0xdef');
    expect(a.reputation).not.toEqual(b.reputation);
  });

  it('returns six reputation axes bounded 0–100', () => {
    const { reputation } = buildMockAnalytics('wallet');
    expect(reputation).toHaveLength(6);
    for (const axis of reputation) {
      expect(axis.value).toBeGreaterThanOrEqual(0);
      expect(axis.value).toBeLessThanOrEqual(100);
    }
  });

  it('returns a 30-point accuracy series clamped to 0–100', () => {
    const { accuracy } = buildMockAnalytics('wallet');
    expect(accuracy).toHaveLength(30);
    expect(accuracy.every((p) => p.price >= 0 && p.price <= 100)).toBe(true);
  });
});
