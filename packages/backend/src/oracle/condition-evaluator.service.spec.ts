import {
  ConditionEvaluationError,
  ConditionEvaluatorService,
  PriceDataset,
} from './condition-evaluator.service';

/**
 * BE-015: condition parsing and multi-outcome evaluation.
 *
 * These are the tests that decide whether a market settles correctly, so they
 * lean on boundaries: the exact threshold, one ULP either side of it, a price
 * below the lowest bucket, a gap between two buckets. Every one of those is a
 * case where a plausible-looking implementation picks a *different* winner than
 * its peers, and a market that settles differently on two oracle nodes is a
 * market that is stolen from whoever is on the losing side.
 */

const at = (final: number, open?: number): PriceDataset =>
  open === undefined ? { final } : { final, open };

describe('ConditionEvaluatorService — parsing (BE-015)', () => {
  let evaluator: ConditionEvaluatorService;

  beforeEach(() => {
    evaluator = new ConditionEvaluatorService();
  });

  it('parses each supported condition type', () => {
    expect(evaluator.parse({ type: 'ABOVE_PRICE', targetPrice: 100 })).toEqual({
      type: 'ABOVE_PRICE',
      target: 100,
    });
    expect(evaluator.parse({ type: 'BELOW_PRICE', targetPrice: 100 })).toEqual({
      type: 'BELOW_PRICE',
      target: 100,
    });
    expect(
      evaluator.parse({ type: 'BETWEEN_RANGE', min: 50, max: 150 }),
    ).toEqual({ type: 'BETWEEN_RANGE', min: 50, max: 150 });
    expect(evaluator.parse({ type: 'PERCENT_GAIN', percent: 10 })).toEqual({
      type: 'PERCENT_GAIN',
      percent: 10,
    });
    expect(
      evaluator.parse({
        type: 'MULTI_OUTCOME_BUCKETS',
        buckets: [
          { min: 0, max: 100 },
          { min: 100, max: 200 },
        ],
      }),
    ).toEqual({
      type: 'MULTI_OUTCOME_BUCKETS',
      buckets: [
        { min: 0, max: 100 },
        { min: 100, max: 200 },
      ],
    });
  });

  it('accepts the legacy { direction, targetPrice } shape', () => {
    expect(evaluator.parse({ direction: 'above', targetPrice: 42 })).toEqual({
      type: 'ABOVE_PRICE',
      target: 42,
    });
    expect(evaluator.parse({ direction: 'below', targetPrice: 42 })).toEqual({
      type: 'BELOW_PRICE',
      target: 42,
    });
  });

  it('rejects anything that is not an object', () => {
    for (const bad of [null, undefined, 42, 'ABOVE_PRICE', true]) {
      expect(() => evaluator.parse(bad)).toThrow(ConditionEvaluationError);
    }
  });

  it('rejects an unknown condition type by name', () => {
    expect(() => evaluator.parse({ type: 'MOON_PHASE' })).toThrow(
      /Unsupported condition type "MOON_PHASE"/,
    );
  });

  it('rejects a shape it cannot infer a type from', () => {
    expect(() => evaluator.parse({ targetPrice: 10 })).toThrow(
      /missing a "type"/,
    );
  });

  it('names the missing field', () => {
    expect(() => evaluator.parse({ type: 'ABOVE_PRICE' })).toThrow(
      /missing required field "targetPrice"/,
    );
  });

  it('rejects a non-numeric threshold', () => {
    expect(() =>
      evaluator.parse({ type: 'ABOVE_PRICE', targetPrice: '100' }),
    ).toThrow(/must be a finite number/);
    expect(() =>
      evaluator.parse({ type: 'ABOVE_PRICE', targetPrice: Number.NaN }),
    ).toThrow(/must be a finite number/);
    expect(() =>
      evaluator.parse({
        type: 'ABOVE_PRICE',
        targetPrice: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/must be a finite number/);
  });

  it('rejects an inverted range', () => {
    expect(() =>
      evaluator.parse({ type: 'BETWEEN_RANGE', min: 150, max: 50 }),
    ).toThrow(/requires min < max/);
    expect(() =>
      evaluator.parse({ type: 'BETWEEN_RANGE', min: 100, max: 100 }),
    ).toThrow(/requires min < max/);
  });
});

describe('ConditionEvaluatorService — ABOVE_PRICE / BELOW_PRICE (BE-015)', () => {
  const evaluator = new ConditionEvaluatorService();
  const above = { type: 'ABOVE_PRICE', targetPrice: 100 };
  const below = { type: 'BELOW_PRICE', targetPrice: 100 };

  it('resolves above the target to yes', () => {
    expect(evaluator.evaluate(above, at(101)).outcomeIndex).toBe(1);
  });

  it('resolves below the target to no', () => {
    expect(evaluator.evaluate(above, at(99)).outcomeIndex).toBe(0);
  });

  it('treats the threshold itself as a win', () => {
    expect(evaluator.evaluate(above, at(100)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(below, at(100)).outcomeIndex).toBe(1);
  });

  it('flips one ULP below the threshold to a loss', () => {
    expect(evaluator.evaluate(above, at(99.999999999)).outcomeIndex).toBe(0);
    expect(evaluator.evaluate(above, at(100.000000001)).outcomeIndex).toBe(1);
  });

  it('reports two outcomes and a rationale', () => {
    const result = evaluator.evaluate(above, at(150));
    expect(result.outcomeCount).toBe(2);
    expect(result.type).toBe('ABOVE_PRICE');
    expect(result.rationale).toBe('Final price 150 >= 100');
  });

  it('handles a zero target', () => {
    expect(
      evaluator.evaluate({ type: 'ABOVE_PRICE', targetPrice: 0 }, at(0))
        .outcomeIndex,
    ).toBe(1);
  });
});

describe('ConditionEvaluatorService — BETWEEN_RANGE (BE-015)', () => {
  const evaluator = new ConditionEvaluatorService();
  const range = { type: 'BETWEEN_RANGE', min: 100, max: 200 };

  it('resolves inside the range to yes', () => {
    expect(evaluator.evaluate(range, at(150)).outcomeIndex).toBe(1);
  });

  it('includes both boundaries', () => {
    expect(evaluator.evaluate(range, at(100)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(range, at(200)).outcomeIndex).toBe(1);
  });

  it('resolves just outside the boundaries to no', () => {
    expect(evaluator.evaluate(range, at(99.99)).outcomeIndex).toBe(0);
    expect(evaluator.evaluate(range, at(200.01)).outcomeIndex).toBe(0);
  });

  it('is not tripped by floating-point noise at a boundary', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; a boundary comparison without tolerance
    // resolves this market differently depending on how the price was summed.
    const noisy = { type: 'BETWEEN_RANGE', min: 0.1, max: 0.3 };
    expect(evaluator.evaluate(noisy, at(0.1 + 0.2)).outcomeIndex).toBe(1);
  });
});

describe('ConditionEvaluatorService — PERCENT_GAIN (BE-015)', () => {
  const evaluator = new ConditionEvaluatorService();
  const gain = { type: 'PERCENT_GAIN', percent: 10 };

  it('resolves a qualifying gain to yes', () => {
    expect(evaluator.evaluate(gain, at(110, 100)).outcomeIndex).toBe(1);
  });

  it('resolves an insufficient gain to no', () => {
    expect(evaluator.evaluate(gain, at(109.99, 100)).outcomeIndex).toBe(0);
  });

  it('treats exactly the threshold as a win', () => {
    expect(evaluator.evaluate(gain, at(110, 100)).outcomeIndex).toBe(1);
  });

  it('measures the move relative to the open price, not absolutely', () => {
    // +10% of $100 is +$10; +10% of $10,000 is +$1,000. Both are the same market.
    expect(evaluator.evaluate(gain, at(11_000, 10_000)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(gain, at(1_100, 1_000)).outcomeIndex).toBe(1);
  });

  it('rejects a negative threshold instead of guessing its meaning', () => {
    // "percent: -10" has two defensible readings — "gained at least -10%"
    // (trivially true) and "fell by at least 10%". Guessing one of them lets
    // two oracle nodes resolve the same market differently, so it is refused.
    expect(() =>
      evaluator.evaluate({ type: 'PERCENT_GAIN', percent: -10 }, at(90, 100)),
    ).toThrow(/must be >= 0/);
  });

  it('points a "did it fall" market at BELOW_PRICE', () => {
    expect(() =>
      evaluator.evaluate({ type: 'PERCENT_GAIN', percent: -10 }, at(90, 100)),
    ).toThrow(/use BELOW_PRICE/);

    expect(
      evaluator.evaluate({ type: 'BELOW_PRICE', targetPrice: 90 }, at(90))
        .outcomeIndex,
    ).toBe(1);
  });

  it('raises rather than guessing when the open price is unusable', () => {
    expect(() => evaluator.evaluate(gain, at(110))).toThrow(
      /requires a positive "open" price/,
    );
    expect(() => evaluator.evaluate(gain, at(110, 0))).toThrow(
      ConditionEvaluationError,
    );
    expect(() => evaluator.evaluate(gain, at(110, -5))).toThrow(
      ConditionEvaluationError,
    );
  });

  it('records the observed move in the rationale', () => {
    expect(evaluator.evaluate(gain, at(105, 100)).rationale).toBe(
      'Price moved 5.0000% (100 -> 105), threshold 10%',
    );
  });
});

describe('ConditionEvaluatorService — MULTI_OUTCOME_BUCKETS (BE-015)', () => {
  const evaluator = new ConditionEvaluatorService();
  const brackets = {
    type: 'MULTI_OUTCOME_BUCKETS',
    buckets: [
      { min: 0, max: 1_000, label: 'under 1k' },
      { min: 1_000, max: 10_000, label: '1k-10k' },
      { min: 10_000, max: 100_000, label: '10k-100k' },
      { min: 100_000, max: 1_000_000, label: '100k-1m' },
    ],
  };

  it('returns the index of the matching bucket', () => {
    expect(evaluator.evaluate(brackets, at(500)).outcomeIndex).toBe(0);
    expect(evaluator.evaluate(brackets, at(5_000)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(brackets, at(50_000)).outcomeIndex).toBe(2);
    expect(evaluator.evaluate(brackets, at(500_000)).outcomeIndex).toBe(3);
  });

  it('reports the total outcome count', () => {
    const result = evaluator.evaluate(brackets, at(5_000));
    expect(result.outcomeCount).toBe(4);
    expect(result.outcomeIndex).toBe(1);
  });

  it('assigns a shared boundary to exactly one bucket', () => {
    // Buckets are [min, max): 1,000 belongs to the upper bracket, never both.
    expect(evaluator.evaluate(brackets, at(1_000)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(brackets, at(999.999)).outcomeIndex).toBe(0);
    expect(evaluator.evaluate(brackets, at(10_000)).outcomeIndex).toBe(2);
  });

  it('settles into an unbounded top bucket', () => {
    const openEnded = {
      type: 'MULTI_OUTCOME_BUCKETS',
      buckets: [{ min: 0, max: 100 }, { min: 100 }],
    };
    expect(evaluator.evaluate(openEnded, at(99)).outcomeIndex).toBe(0);
    expect(evaluator.evaluate(openEnded, at(100)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(openEnded, at(9_000_000)).outcomeIndex).toBe(1);
  });

  it('rejects a negative price before it can reach a bucket lookup', () => {
    expect(() => evaluator.evaluate(brackets, at(-1))).toThrow(
      /must not be negative/,
    );
  });

  it('rejects a NaN price before it can reach a bucket lookup', () => {
    expect(() => evaluator.evaluate(brackets, at(Number.NaN))).toThrow(
      /must be a finite number/,
    );
  });

  it('raises when the price is below the lowest declared min', () => {
    const highFloor = {
      type: 'MULTI_OUTCOME_BUCKETS',
      buckets: [
        { min: 500, max: 1_000 },
        { min: 1_000, max: 2_000 },
      ],
    };
    expect(() => evaluator.evaluate(highFloor, at(100))).toThrow(
      ConditionEvaluationError,
    );
  });

  it('rejects an empty bucket list', () => {
    expect(() =>
      evaluator.evaluate({ type: 'MULTI_OUTCOME_BUCKETS', buckets: [] }, at(1)),
    ).toThrow(/non-empty "buckets" array/);
  });

  it('rejects overlapping buckets at parse time', () => {
    expect(() =>
      evaluator.parse({
        type: 'MULTI_OUTCOME_BUCKETS',
        buckets: [
          { min: 0, max: 100 },
          { min: 50, max: 200 },
        ],
      }),
    ).toThrow(/overlapping bucket/);
  });

  it('rejects a gap between buckets at parse time', () => {
    expect(() =>
      evaluator.parse({
        type: 'MULTI_OUTCOME_BUCKETS',
        buckets: [
          { min: 0, max: 100 },
          { min: 200, max: 300 },
        ],
      }),
    ).toThrow(/No bucket covers the gap/);
  });

  it('rejects a bucket whose max is not above its min', () => {
    expect(() =>
      evaluator.parse({
        type: 'MULTI_OUTCOME_BUCKETS',
        buckets: [{ min: 100, max: 100 }],
      }),
    ).toThrow(/requires max > min/);
  });

  it('rejects a non-object bucket', () => {
    expect(() =>
      evaluator.parse({
        type: 'MULTI_OUTCOME_BUCKETS',
        buckets: [42],
      }),
    ).toThrow(/Bucket 0 must be an object/);
  });

  it('supports a large bracket count', () => {
    const many = {
      type: 'MULTI_OUTCOME_BUCKETS',
      buckets: Array.from({ length: 20 }, (_, i) => ({
        min: i * 100,
        max: (i + 1) * 100,
      })),
    };
    expect(evaluator.evaluate(many, at(1_950)).outcomeIndex).toBe(19);
    expect(evaluator.evaluate(many, at(50)).outcomeIndex).toBe(0);
  });
});

describe('ConditionEvaluatorService — price validation (BE-015)', () => {
  const evaluator = new ConditionEvaluatorService();
  const above = { type: 'ABOVE_PRICE', targetPrice: 100 };

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '150'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s as a final price', (_label, final) => {
    expect(() => evaluator.evaluate(above, { final: final as number })).toThrow(
      /final price must be a finite number/,
    );
  });

  it('rejects a negative final price', () => {
    expect(() => evaluator.evaluate(above, at(-1))).toThrow(
      /must not be negative/,
    );
  });
});

describe('ConditionEvaluatorService — determinism and helpers (BE-015)', () => {
  const evaluator = new ConditionEvaluatorService();
  const brackets = {
    type: 'MULTI_OUTCOME_BUCKETS',
    buckets: [{ min: 0, max: 100 }, { min: 100, max: 200 }, { min: 200 }],
  };

  it('returns the same index across repeated evaluations', () => {
    const first = evaluator.evaluate(brackets, at(150));
    for (let i = 0; i < 50; i++) {
      expect(evaluator.evaluate(brackets, at(150))).toEqual(first);
    }
  });

  it('is unaffected by the key order of the condition object', () => {
    const a = evaluator.evaluate(
      { min: 100, max: 200, type: 'BETWEEN_RANGE' },
      at(150),
    );
    const b = evaluator.evaluate(
      { type: 'BETWEEN_RANGE', max: 200, min: 100 },
      at(150),
    );
    expect(a).toEqual(b);
  });

  it('never re-sorts buckets, so outcome indices track declaration order', () => {
    expect(evaluator.evaluate(brackets, at(50)).outcomeIndex).toBe(0);
    expect(evaluator.evaluate(brackets, at(150)).outcomeIndex).toBe(1);
    expect(evaluator.evaluate(brackets, at(500)).outcomeIndex).toBe(2);

    // Renumbering the buckets would silently re-map every staker's position,
    // so a descending list is refused instead of quietly sorted.
    const reversed = {
      type: 'MULTI_OUTCOME_BUCKETS',
      buckets: [{ min: 200 }, { min: 100, max: 200 }, { min: 0, max: 100 }],
    };
    expect(() => evaluator.evaluate(reversed, at(50))).toThrow(
      ConditionEvaluationError,
    );
  });

  it('exposes the outcome count for a condition', () => {
    expect(
      evaluator.outcomeCount({ type: 'ABOVE_PRICE', targetPrice: 1 }),
    ).toBe(2);
    expect(evaluator.outcomeCount(brackets)).toBe(3);
  });

  it('reduces a binary condition to a boolean', () => {
    expect(
      evaluator.evaluateBoolean(
        { type: 'ABOVE_PRICE', targetPrice: 100 },
        at(150),
      ),
    ).toBe(true);
    expect(
      evaluator.evaluateBoolean(
        { type: 'ABOVE_PRICE', targetPrice: 100 },
        at(50),
      ),
    ).toBe(false);
  });

  it('refuses to flatten a multi-outcome condition to a boolean', () => {
    expect(() => evaluator.evaluateBoolean(brackets, at(150))).toThrow(
      /cannot be reduced to a boolean/,
    );
  });

  it('reports the evaluated condition type', () => {
    expect(evaluator.evaluate(brackets, at(150)).type).toBe(
      'MULTI_OUTCOME_BUCKETS',
    );
  });
});
