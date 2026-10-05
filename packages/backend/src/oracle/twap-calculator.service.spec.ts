import { ConfigService } from '@nestjs/config';

import {
  Candle,
  CANDLE_SOURCE,
  CandleSource,
  InsufficientCandleWindowError,
  TwapCalculatorService,
} from './twap-calculator.service';

/**
 * BE-013: TWAP / standard-deviation outlier rejection.
 *
 * The scenario every test circles back to: a thin pool is pushed to 10x by a
 * flash loan for one block, and a naive oracle settles the whole market on
 * that print. The window below is a quiet market around $100 that gets hit by
 * exactly that spike, and the filter has to refuse it while leaving every
 * legitimate price alone.
 */

const T0 = 1_700_000_000;
const FIFTEEN_MIN = 900;

/** Four quiet 15-minute candles hovering around $100. */
const QUIET_WINDOW: Candle[] = [0, 1, 2, 3].map((i) => ({
  timestamp: T0 - (3 - i) * FIFTEEN_MIN,
  close: 100 + i, // 100, 101, 102, 103
  volume: 250_000,
}));

function makeService(
  overrides: Record<string, unknown> = {},
): TwapCalculatorService {
  const config = {
    get: jest.fn((key: string, def?: unknown) =>
      key in overrides ? overrides[key] : def,
    ),
  } as unknown as ConfigService;
  return new TwapCalculatorService(config);
}

describe('TwapCalculatorService — TWAP computation (BE-013)', () => {
  let service: TwapCalculatorService;

  beforeEach(() => {
    service = makeService();
  });

  it('averages evenly-spaced candles', () => {
    // (100 + 101 + 102 + 103) / 4
    expect(service.computeTwap(QUIET_WINDOW)).toBeCloseTo(101.5, 6);
  });

  it('ignores input order', () => {
    const shuffled = [
      QUIET_WINDOW[2],
      QUIET_WINDOW[0],
      QUIET_WINDOW[3],
      QUIET_WINDOW[1],
    ];
    expect(service.computeTwap(shuffled)).toBeCloseTo(
      service.computeTwap(QUIET_WINDOW),
      10,
    );
  });

  it('weights by elapsed time, not by candle count', () => {
    // Two candles: $100 held for 900s, then $200 for another 900s.
    const candles: Candle[] = [
      { timestamp: T0, close: 100 },
      { timestamp: T0 + FIFTEEN_MIN, close: 200 },
    ];
    expect(service.computeTwap(candles)).toBeCloseTo(150, 6);
  });

  it('is stable across irregular candle timestamps', () => {
    // The same 4-hour price path, sampled as 4 candles and as 16 candles.
    const hourly: Candle[] = [0, 1, 2, 3].map((i) => ({
      timestamp: T0 - (3 - i) * 3600,
      close: 100 + i,
    }));
    const quarterHourly: Candle[] = Array.from({ length: 16 }, (_, i) => ({
      timestamp: T0 - (15 - i) * 900,
      close: 100 + Math.floor(i / 4),
    }));

    expect(service.computeTwap(hourly)).toBeCloseTo(101.5, 6);
    expect(service.computeTwap(quarterHourly)).toBeCloseTo(101.5, 6);
  });

  it('handles a price path with a long gap without drift', () => {
    // $100 for the first 15m, then a 6-hour hole, then $200.
    const candles: Candle[] = [
      { timestamp: T0, close: 100 },
      { timestamp: T0 + 6 * 3600, close: 200 },
    ];
    // The gap is capped at one candle interval, so the long outage does not
    // let a single stale print dominate the average.
    const twap = service.computeTwap(candles);
    expect(twap).toBeCloseTo(150, 6);
  });

  it('produces a deterministic result across repeated runs', () => {
    const first = service.computeTwap(QUIET_WINDOW);
    const second = service.computeTwap(QUIET_WINDOW);
    expect(first).toBe(second);
  });

  it('keeps 8-decimal fixed-point precision', () => {
    const candles: Candle[] = [
      { timestamp: T0, close: 1.00000001 },
      { timestamp: T0 + FIFTEEN_MIN, close: 1.00000003 },
    ];
    // Averaging must not round the sub-cent digits away.
    expect(service.computeTwap(candles)).toBeCloseTo(1.00000002, 8);
  });

  it('excludes zero, negative and non-finite candles from the average', () => {
    const candles: Candle[] = [
      { timestamp: T0, close: 100 },
      { timestamp: T0 + FIFTEEN_MIN, close: 0 },
      { timestamp: T0 + 2 * FIFTEEN_MIN, close: Number.NaN },
      { timestamp: T0 + 3 * FIFTEEN_MIN, close: 102 },
    ];
    expect(service.computeTwap(candles)).toBeCloseTo(101, 6);
  });

  it('throws on an empty window', () => {
    expect(() => service.computeTwap([])).toThrow(
      InsufficientCandleWindowError,
    );
  });

  it('throws when no candle has a usable price', () => {
    expect(() =>
      service.computeTwap([
        { timestamp: T0, close: 0 },
        { timestamp: T0 + FIFTEEN_MIN, close: -5 },
      ]),
    ).toThrow(/no positive-price interval/);
  });
});

describe('TwapCalculatorService — standard deviation (BE-013)', () => {
  let service: TwapCalculatorService;

  beforeEach(() => {
    service = makeService();
  });

  it('computes the population standard deviation', () => {
    // [100, 101, 102, 103]: mean 101.5, population sigma = sqrt(1.25)
    expect(service.computeStdDev(QUIET_WINDOW)).toBeCloseTo(Math.sqrt(1.25), 6);
  });

  it('uses the population (N) divisor, not the sample (N-1) one', () => {
    const sampleSigma = Math.sqrt(5 / 3); // 1.29099…
    expect(service.computeStdDev(QUIET_WINDOW)).not.toBeCloseTo(sampleSigma, 6);
  });

  it('throws when every price is identical', () => {
    expect(() =>
      service.computeStdDev([
        { timestamp: T0, close: 100 },
        { timestamp: T0 + FIFTEEN_MIN, close: 100 },
      ]),
    ).toThrow(/zero variance/);
  });

  it('throws with fewer than two priced candles', () => {
    expect(() =>
      service.computeStdDev([{ timestamp: T0, close: 100 }]),
    ).toThrow(/at least 2 priced candles/);
  });

  it('scales with the size of the move', () => {
    const quiet = [100, 101, 102, 103];
    const wild = [100, 140, 60, 180];
    const toCandles = (prices: number[]): Candle[] =>
      prices.map((close, i) => ({ timestamp: T0 + i * FIFTEEN_MIN, close }));

    expect(service.computeStdDev(toCandles(wild))).toBeGreaterThan(
      service.computeStdDev(toCandles(quiet)),
    );
  });
});

describe('TwapCalculatorService — robust scale (BE-013)', () => {
  let service: TwapCalculatorService;

  beforeEach(() => {
    service = makeService();
  });

  it('equals 1.4826 x MAD about the median', () => {
    // [100, 101, 102, 103]: median 101.5, MAD 1.0 => sigma 1.4826
    expect(service.computeRobustStdDev(QUIET_WINDOW)).toBeCloseTo(1.4826, 6);
  });

  it('agrees with the population sigma on bell-shaped data', () => {
    // The 1.4826 factor is chosen precisely so ">3 sigma" keeps its usual
    // meaning on an undistorted market: MAD is a consistent estimator of sigma
    // for normally distributed prices.
    const bellShaped: Candle[] = [96, 98, 99, 100, 100, 101, 102, 104].map(
      (close, i) => ({ timestamp: T0 + i * FIFTEEN_MIN, close }),
    );

    expect(service.computeRobustStdDev(bellShaped)).toBeCloseTo(
      service.computeStdDev(bellShaped),
      0,
    );
  });

  it('is deliberately more permissive than the population sigma on a smooth ramp', () => {
    // Documented trade-off, not an accident. MAD over-estimates sigma for a
    // uniform (ramp-shaped) price path by up to ~2x, so the gate is slightly
    // looser on well-ordered markets. That is the price paid for a scale that
    // a single manipulation cannot move; the alternative is a filter that the
    // manipulation disables.
    const ramp: Candle[] = [100, 101, 102, 103, 104, 105].map((close, i) => ({
      timestamp: T0 + i * FIFTEEN_MIN,
      close,
    }));

    expect(service.computeRobustStdDev(ramp)).toBeGreaterThan(
      service.computeStdDev(ramp),
    );
  });

  it('is not inflated by the very outlier it exists to detect', () => {
    const manipulated = [
      ...QUIET_WINDOW,
      { timestamp: T0 + FIFTEEN_MIN, close: 900 },
    ];

    // The population sigma is dragged to ~$320 by the spike, which would put
    // the spike barely 2 sigma out and let it through a 3 sigma gate.
    expect(service.computeStdDev(manipulated)).toBeGreaterThan(300);

    // The robust sigma barely moves: the spike is a minority of the window's
    // deviations, so it does not shift the median of them.
    expect(service.computeRobustStdDev(manipulated)).toBeCloseTo(1.4826, 3);
  });

  it('is unchanged by one poisoned candle in six', () => {
    const clean: Candle[] = [100, 101, 102, 103, 104, 105].map((close, i) => ({
      timestamp: T0 + i * FIFTEEN_MIN,
      close,
    }));
    const poisoned: Candle[] = [
      { timestamp: T0, close: 100 },
      { timestamp: T0 + FIFTEEN_MIN, close: 101 },
      { timestamp: T0 + 2 * FIFTEEN_MIN, close: 102 },
      { timestamp: T0 + 3 * FIFTEEN_MIN, close: 103 },
      { timestamp: T0 + 4 * FIFTEEN_MIN, close: 104 },
      { timestamp: T0 + 5 * FIFTEEN_MIN, close: 900 },
    ];

    expect(service.computeRobustStdDev(poisoned)).toBe(
      service.computeRobustStdDev(clean),
    );
    // The population sigma, by contrast, more than triples.
    expect(service.computeStdDev(poisoned)).toBeGreaterThan(
      service.computeStdDev(clean) * 3,
    );
  });

  it('rejects an outlier however extreme the print is', () => {
    const serviceUnderTest = makeService();
    for (const spike of [200, 5_000, 1_000_000]) {
      const window = [
        ...QUIET_WINDOW,
        { timestamp: T0 + FIFTEEN_MIN, close: spike },
      ];
      expect(serviceUnderTest.evaluateWithCandles(window, spike).accepted).toBe(
        false,
      );
    }
  });

  it('throws when every price is identical', () => {
    expect(() =>
      service.computeRobustStdDev([
        { timestamp: T0, close: 100 },
        { timestamp: T0 + FIFTEEN_MIN, close: 100 },
      ]),
    ).toThrow(/zero dispersion/);
  });

  it('throws with fewer than two priced candles', () => {
    expect(() =>
      service.computeRobustStdDev([{ timestamp: T0, close: 100 }]),
    ).toThrow(/at least 2 priced candles/);
  });

  it('preserves sub-cent dispersion instead of truncating it to zero', () => {
    // A market that moved by 1e-8 has real, non-zero dispersion; truncating it
    // would declare the window degenerate and freeze an otherwise fine market.
    const hair: Candle[] = [
      { timestamp: T0, close: 100 },
      { timestamp: T0 + FIFTEEN_MIN, close: 100.00000001 },
    ];

    expect(service.computeRobustStdDev(hair)).toBeGreaterThan(0);
    expect(service.computeRobustStdDev(hair)).toBeCloseTo(1.4826e-8, 12);
  });
});

describe('TwapCalculatorService — outlier verdict (BE-013)', () => {
  it('rejects a flash-loan price spike beyond 3 sigma', () => {
    const service = makeService();
    // Quiet around $100, then one block prints $900.
    const manipulated = [
      ...QUIET_WINDOW,
      { timestamp: T0 + FIFTEEN_MIN, close: 900, volume: 1_200 },
    ];

    const verdict = service.evaluateWithCandles(manipulated, 900);

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('sigma-deviation');
    expect(verdict.deviationSigmas).toBeGreaterThan(3);
    expect(verdict.sigmaDistance).toBeGreaterThan(0);
    expect(verdict.detail).toMatch(/flash loan/);
  });

  it('rejects a manipulated dump as well as a pump', () => {
    const service = makeService();
    const manipulated = [
      ...QUIET_WINDOW,
      { timestamp: T0 + FIFTEEN_MIN, close: 5, volume: 900 },
    ];

    const verdict = service.evaluateWithCandles(manipulated, 5);

    expect(verdict.accepted).toBe(false);
    expect(verdict.sigmaDistance).toBeLessThan(0);
    expect(verdict.detail).toMatch(/below/);
  });

  it('accepts a price that sits inside the band', () => {
    const service = makeService();
    const verdict = service.evaluateWithCandles(QUIET_WINDOW, 103);

    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toBeUndefined();
    expect(verdict.deviationSigmas).toBeLessThan(3);
  });

  it('accepts a price exactly on the threshold boundary', () => {
    const service = makeService();
    const base = service.evaluateWithCandles(QUIET_WINDOW, 101.5);
    const onBoundary = service.evaluateWithCandles(
      QUIET_WINDOW,
      base.twap + base.stdDev * 3,
    );

    // Strictly greater-than: exactly 3σ is still inside the band.
    expect(onBoundary.deviationSigmas).toBeCloseTo(3, 10);
    expect(onBoundary.accepted).toBe(true);
  });

  it('rejects one step past the threshold boundary', () => {
    const service = makeService();
    const base = service.evaluateWithCandles(QUIET_WINDOW, 101.5);

    const past = service.evaluateWithCandles(
      QUIET_WINDOW,
      base.twap + base.stdDev * 3.0001,
    );

    expect(past.accepted).toBe(false);
  });

  it('honours a configured threshold', () => {
    const strict = makeService({ ORACLE_TWAP_SIGMA_THRESHOLD: '1' });
    const lenient = makeService({ ORACLE_TWAP_SIGMA_THRESHOLD: '10' });

    expect(strict.evaluateWithCandles(QUIET_WINDOW, 103).accepted).toBe(false);
    expect(lenient.evaluateWithCandles(QUIET_WINDOW, 103).accepted).toBe(true);
  });

  it('refuses to judge a window that is too thin', () => {
    const service = makeService();
    const verdict = service.evaluateWithCandles(QUIET_WINDOW.slice(0, 2), 100);

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('insufficient-candles');
    expect(verdict.sampleSize).toBe(2);
  });

  it('refuses to judge a flat market where sigma is undefined', () => {
    const service = makeService();
    const flat: Candle[] = [0, 1, 2, 3].map((i) => ({
      timestamp: T0 + i * FIFTEEN_MIN,
      close: 100,
    }));

    const verdict = service.evaluateWithCandles(flat, 100);

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('degenerate-window');
  });

  it('rejects an unusable spot price without throwing', async () => {
    const service = makeService();
    for (const spot of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = await service.evaluate('0xabc', spot, T0, QUIET_WINDOW);
      expect(verdict.accepted).toBe(false);
      expect(verdict.reason).toBe('invalid-spot');
    }
  });

  it('rejects rather than settles when the history provider is down', async () => {
    const service = makeService();
    const verdict = await service.evaluate('0xabc', 100, T0, undefined);

    // No CANDLE_SOURCE registered => history unavailable => fail closed.
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('insufficient-candles');
    expect(verdict.detail).toMatch(/Price history unavailable/);
  });

  it('reports the window bounds it actually covered', () => {
    const service = makeService();
    const verdict = service.evaluateWithCandles(QUIET_WINDOW, 101);

    expect(verdict.windowStart).toBe(QUIET_WINDOW[0].timestamp);
    expect(verdict.windowEnd).toBe(QUIET_WINDOW[3].timestamp);
    expect(verdict.sampleSize).toBe(4);
  });
});

describe('TwapCalculatorService — candle source wiring (BE-013)', () => {
  it('fetches history through the injected source', async () => {
    const source: CandleSource = {
      fetchCandles: jest.fn().mockResolvedValue(QUIET_WINDOW),
    };
    const service = new TwapCalculatorService(
      {
        get: jest.fn((_k: string, d?: unknown) => d),
      } as unknown as ConfigService,
      source,
    );

    const verdict = await service.evaluate('0xdead', 101, T0 + 4 * FIFTEEN_MIN);

    expect(source.fetchCandles).toHaveBeenCalledWith(
      '0xdead',
      Math.floor(T0 + 4 * FIFTEEN_MIN - (4 * 60 * 60 * 1000) / 1000),
      T0 + 4 * FIFTEEN_MIN,
    );
    expect(verdict.accepted).toBe(true);
  });

  it('rejects when the injected source throws', async () => {
    const source: CandleSource = {
      fetchCandles: jest.fn().mockRejectedValue(new Error('DEX timeout')),
    };
    const service = new TwapCalculatorService(
      {
        get: jest.fn((_k: string, d?: unknown) => d),
      } as unknown as ConfigService,
      source,
    );

    const verdict = await service.evaluate('0xdead', 101, T0);

    expect(verdict.accepted).toBe(false);
    expect(verdict.detail).toMatch(/DEX timeout/);
  });

  it('sums window volume for the liquidity check', () => {
    const service = makeService();
    expect(service.sumVolume(QUIET_WINDOW)).toBe(1_000_000);
    expect(service.sumVolume([{ timestamp: T0, close: 1 }])).toBe(0);
  });

  it('exposes CANDLE_SOURCE as an injection token', () => {
    expect(typeof CANDLE_SOURCE).toBe('symbol');
  });
});
