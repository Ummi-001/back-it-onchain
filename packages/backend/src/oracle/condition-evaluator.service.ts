import { Injectable, Logger } from '@nestjs/common';

/**
 * condition-evaluator.service.ts (BE-015)
 *
 * Turns a market's `conditionJson` into a single, unambiguous outcome index.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **Determinism.** Every node that evaluates a call must land on the same
 *     index, and it must land on the same index on every re-run. So there is
 *     no clock, no randomness, no floating-point comparison at a boundary, and
 *     no dependence on object key order. The same input always produces the
 *     same output, on any machine, forever.
 *
 *  2. **Failing closed.** An unparseable or ambiguous condition must raise,
 *     never guess. The old behaviour in `OracleService.determineOutcome` was to
 *     log a warning and return `false`; a market whose condition failed to
 *     parse therefore resolved *no* — a silent, systematic loss for every
 *     "yes" position in the market. `ConditionEvaluationError` makes that
 *     failure loud and routes the call to review instead.
 *
 * Every function here is pure: no I/O, no clock, no logging side effects in the
 * evaluation path. The only impure member is the thin `evaluate()` wrapper.
 */

/** Condition kinds the engine understands. */
export type ConditionType =
  | 'ABOVE_PRICE'
  | 'BELOW_PRICE'
  | 'BETWEEN_RANGE'
  | 'PERCENT_GAIN'
  | 'MULTI_OUTCOME_BUCKETS';

/**
 * The price dataset a condition is evaluated against. `open` is the reference
 * price for `PERCENT_GAIN`; it is ignored by every other condition type.
 */
export interface PriceDataset {
  /** Price at the call's `startTs` — the baseline for percentage moves. */
  open?: number;
  /** Price at the call's `endTs` — the price being judged. */
  final: number;
}

/** One price band in a multi-outcome market. Bounds are `[lower, upper)`. */
export interface Bucket {
  /** Inclusive lower bound. */
  min: number;
  /**
   * Exclusive upper bound. The final bucket of a market may omit `max` (or set
   * it to `null`) to mean "and everything above".
   */
  max?: number | null;
  /** Optional display label; the index is what the contract settles on. */
  label?: string;
}

/**
 * A bucket after validation: `max` is always a number, with the unbounded top
 * bucket normalised to `Infinity`. Keeping this separate from the input shape
 * means the evaluation path never has to re-check for a missing bound.
 */
export interface NormalizedBucket {
  min: number;
  max: number;
  label?: string;
}

/** A parsed, validated condition. Produced by `parse()`. */
export type ParsedCondition =
  | { type: 'ABOVE_PRICE'; target: number }
  | { type: 'BELOW_PRICE'; target: number }
  | { type: 'BETWEEN_RANGE'; min: number; max: number }
  | { type: 'PERCENT_GAIN'; percent: number }
  | { type: 'MULTI_OUTCOME_BUCKETS'; buckets: NormalizedBucket[] };

/** The result of evaluating a condition. */
export interface ConditionResult {
  /** Winning outcome index, 0-based. Always within `[0, outcomeCount)`. */
  outcomeIndex: number;
  /** Total number of outcomes this condition can produce. */
  outcomeCount: number;
  /** The condition type that produced the verdict. */
  type: ConditionType;
  /** Short explanation suitable for an audit log or a notification. */
  rationale: string;
}

/** Thrown when a condition cannot be parsed or evaluated. */
export class ConditionEvaluationError extends Error {
  constructor(
    public readonly code: ConditionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConditionEvaluationError';
  }
}

export type ConditionErrorCode =
  | 'malformed-condition'
  | 'unknown-condition-type'
  | 'missing-field'
  | 'invalid-field'
  | 'empty-buckets'
  | 'overlapping-buckets'
  | 'uncovered-range'
  | 'open-price-missing'
  | 'invalid-price';

/** Binary markets settle to exactly two outcomes: 0 = no, 1 = yes. */
export const BINARY_OUTCOME_COUNT = 2;
/** A "yes" win, expressed as the contract's boolean outcome. */
export const YES_OUTCOME_INDEX = 1;
/** A "no" win. */
export const NO_OUTCOME_INDEX = 0;

/** Tolerance for price comparisons, in absolute USD. */
const EPSILON = 1e-9;

@Injectable()
export class ConditionEvaluatorService {
  private readonly logger = new Logger(ConditionEvaluatorService.name);

  /**
   * Parses a raw `conditionJson` blob into a validated condition.
   *
   * Accepts the historical shape (`{ direction, targetPrice }`) that
   * `indexer.service.ts` writes for simple above/below markets, and the
   * explicit `type` shape for everything else. Supporting both means existing
   * markets keep resolving while new ones get the full engine.
   *
   * @throws ConditionEvaluationError on anything ambiguous or unrecognised.
   */
  parse(condition: unknown): ParsedCondition {
    if (condition === null || typeof condition !== 'object') {
      throw new ConditionEvaluationError(
        'malformed-condition',
        `Condition must be an object, received ${describe(condition)}`,
      );
    }

    const raw = condition as Record<string, unknown>;
    const type = raw.type ?? inferTypeFromLegacyShape(raw);

    if (typeof type !== 'string') {
      throw new ConditionEvaluationError(
        'unknown-condition-type',
        `Condition is missing a "type" and does not match the legacy above/below shape`,
      );
    }

    switch (type) {
      case 'ABOVE_PRICE':
        return { type, target: requireFiniteNumber(raw, 'targetPrice', type) };
      case 'BELOW_PRICE':
        return { type, target: requireFiniteNumber(raw, 'targetPrice', type) };
      case 'BETWEEN_RANGE':
        return this.parseRange(raw, type);
      case 'PERCENT_GAIN':
        return { type, percent: requireNonNegativePercent(raw, type) };
      case 'MULTI_OUTCOME_BUCKETS':
        return { type, buckets: this.parseBuckets(raw, type) };
      default:
        throw new ConditionEvaluationError(
          'unknown-condition-type',
          `Unsupported condition type "${type}"`,
        );
    }
  }

  /**
   * Evaluates a raw condition against a price dataset.
   *
   * @throws ConditionEvaluationError when the condition is unusable or the
   *         final price cannot settle it unambiguously.
   */
  evaluate(condition: unknown, prices: PriceDataset): ConditionResult {
    return this.evaluateParsed(this.parse(condition), prices);
  }

  /**
   * Evaluates an already-parsed condition. Pure — no I/O, no clock, no I/O.
   *
   * @throws ConditionEvaluationError
   */
  evaluateParsed(
    condition: ParsedCondition,
    prices: PriceDataset,
  ): ConditionResult {
    const final = requireUsablePrice(prices?.final, 'final');

    switch (condition.type) {
      case 'ABOVE_PRICE':
        return this.binaryCompare(
          final >= condition.target,
          final,
          `>=`,
          condition.target,
          condition.type,
        );
      case 'BELOW_PRICE':
        return this.binaryCompare(
          final <= condition.target,
          final,
          `<=`,
          condition.target,
          condition.type,
        );
      case 'BETWEEN_RANGE':
        return this.evaluateRange(condition, final);
      case 'PERCENT_GAIN':
        return this.evaluatePercentGain(condition, prices, final);
      case 'MULTI_OUTCOME_BUCKETS':
        return this.evaluateBuckets(condition, final);
    }
  }

  /**
   * Convenience: the boolean the on-chain `submit_outcome` takes.
   *
   * For binary conditions this is `outcomeIndex === YES_OUTCOME_INDEX`. It
   * throws for multi-outcome conditions, where a single boolean would silently
   * discard every outcome but one — the caller has to handle the index.
   */
  evaluateBoolean(condition: unknown, prices: PriceDataset): boolean {
    const result = this.evaluate(condition, prices);
    if (result.outcomeCount !== BINARY_OUTCOME_COUNT) {
      throw new ConditionEvaluationError(
        'invalid-field',
        `Condition resolves to ${result.outcomeCount} outcomes; it cannot be reduced to a boolean`,
      );
    }
    return result.outcomeIndex === YES_OUTCOME_INDEX;
  }

  /** How many distinct outcomes a condition can produce. */
  outcomeCount(condition: unknown): number {
    const parsed = this.parse(condition);
    return parsed.type === 'MULTI_OUTCOME_BUCKETS'
      ? parsed.buckets.length
      : BINARY_OUTCOME_COUNT;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private binaryCompare(
    isYes: boolean,
    final: number,
    operator: string,
    target: number,
    type: ConditionType,
  ): ConditionResult {
    const outcomeIndex = isYes ? YES_OUTCOME_INDEX : NO_OUTCOME_INDEX;
    return {
      outcomeIndex,
      outcomeCount: BINARY_OUTCOME_COUNT,
      type,
      rationale: `Final price ${final} ${operator} ${target}`,
    };
  }

  private parseRange(
    raw: Record<string, unknown>,
    type: ConditionType,
  ): ParsedCondition {
    const min = requireFiniteNumber(raw, 'min', type);
    const max = requireFiniteNumber(raw, 'max', type);

    if (min >= max) {
      throw new ConditionEvaluationError(
        'invalid-field',
        `BETWEEN_RANGE requires min < max, received min=${min}, max=${max}`,
      );
    }

    return { type: 'BETWEEN_RANGE', min, max };
  }

  /**
   * Validates that buckets form a gapless, ordered partition.
   *
   * The check is deliberately strict. Buckets that overlap or leave a hole make
   * the winning index depend on iteration order, which is exactly the
   * non-determinism this service exists to eliminate — so such a market is
   * rejected at parse time rather than settled arbitrarily.
   */
  private parseBuckets(
    raw: Record<string, unknown>,
    type: ConditionType,
  ): NormalizedBucket[] {
    const rawBuckets = raw.buckets;

    if (!Array.isArray(rawBuckets) || rawBuckets.length === 0) {
      throw new ConditionEvaluationError(
        'empty-buckets',
        'MULTI_OUTCOME_BUCKETS requires a non-empty "buckets" array',
      );
    }

    const buckets: NormalizedBucket[] = rawBuckets.map((entry, i) => {
      if (entry === null || typeof entry !== 'object') {
        throw new ConditionEvaluationError(
          'invalid-field',
          `Bucket ${i} must be an object, received ${describe(entry)}`,
        );
      }
      const b = entry as Record<string, unknown>;
      const min = requireFiniteNumber(b, 'min', `${type}[${i}]`);
      const max =
        b.max === undefined || b.max === null
          ? Number.POSITIVE_INFINITY
          : requireFiniteNumber(b, 'max', `${type}[${i}]`);

      if (max <= min) {
        throw new ConditionEvaluationError(
          'invalid-field',
          `Bucket ${i} requires max > min, received min=${min}, max=${max}`,
        );
      }
      return typeof b.label === 'string'
        ? { min, max, label: b.label }
        : { min, max };
    });

    for (let i = 1; i < buckets.length; i++) {
      const previous = buckets[i - 1];
      const current = buckets[i];

      if (current.min < previous.max) {
        throw new ConditionEvaluationError(
          'overlapping-buckets',
          `Bucket ${i} starts at ${current.min}, overlapping bucket ${i - 1} which ends at ${previous.max}`,
        );
      }
      if (current.min > previous.max) {
        throw new ConditionEvaluationError(
          'uncovered-range',
          `No bucket covers the gap between ${previous.max} and ${current.min}`,
        );
      }
    }

    return buckets;
  }

  /**
   * `BETWEEN_RANGE` resolves to yes when the price is inside the range. The
   * bounds are inclusive, matching how a range is quoted in the market UI.
   */
  private evaluateRange(
    condition: Extract<ParsedCondition, { type: 'BETWEEN_RANGE' }>,
    final: number,
  ): ConditionResult {
    const inRange =
      final >= condition.min - EPSILON && final <= condition.max + EPSILON;
    const outcomeIndex = inRange ? YES_OUTCOME_INDEX : NO_OUTCOME_INDEX;

    return {
      outcomeIndex,
      outcomeCount: BINARY_OUTCOME_COUNT,
      type: 'BETWEEN_RANGE',
      rationale: inRange
        ? `Final price ${final} is inside [${condition.min}, ${condition.max}]`
        : `Final price ${final} is outside [${condition.min}, ${condition.max}]`,
    };
  }

  /**
   * `PERCENT_GAIN` resolves to yes when the price rose by at least `percent`.
   *
   * The threshold must be non-negative. A negative one is rejected at parse
   * time rather than given a special meaning, because there are two defensible
   * readings of "percent: -10" — "gained at least -10%" (trivially true) and
   * "fell by at least 10%" (a *decline* market) — and picking either one
   * silently would let two oracle nodes disagree on the same market. A
   * "did it fall" market belongs in `BELOW_PRICE`.
   *
   * A missing or non-positive `open` price likewise cannot produce a
   * meaningful percentage; returning 0% for it would quietly resolve the
   * market "no", so it raises.
   */
  private evaluatePercentGain(
    condition: Extract<ParsedCondition, { type: 'PERCENT_GAIN' }>,
    prices: PriceDataset,
    final: number,
  ): ConditionResult {
    const open = prices.open;
    if (open === undefined || !Number.isFinite(open) || open <= 0) {
      throw new ConditionEvaluationError(
        'open-price-missing',
        `PERCENT_GAIN requires a positive "open" price, received ${describe(open)}`,
      );
    }

    // Relative change, not a difference, so a 10% move means the same thing at
    // $1 and at $100,000.
    const changePercent = ((final - open) / open) * 100;
    const met = changePercent >= condition.percent - EPSILON;
    const outcomeIndex = met ? YES_OUTCOME_INDEX : NO_OUTCOME_INDEX;

    return {
      outcomeIndex,
      outcomeCount: BINARY_OUTCOME_COUNT,
      type: 'PERCENT_GAIN',
      rationale:
        `Price moved ${changePercent.toFixed(4)}% (${open} -> ${final}), ` +
        `threshold ${condition.percent}%`,
    };
  }

  /**
   * `MULTI_OUTCOME_BUCKETS` returns the index of the band the price falls in.
   *
   * Bands are half-open `[min, max)` so adjacent buckets tile the number line
   * with no overlap and no ambiguity at a shared boundary; the last bucket may
   * be unbounded above. Anything below the first bucket has no winner, which
   * raises rather than defaulting to bucket 0.
   */
  private evaluateBuckets(
    condition: Extract<ParsedCondition, { type: 'MULTI_OUTCOME_BUCKETS' }>,
    final: number,
  ): ConditionResult {
    const { buckets } = condition;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      const aboveLower = final >= bucket.min;
      const belowUpper = final < bucket.max;
      if (aboveLower && belowUpper) {
        return {
          outcomeIndex: i,
          outcomeCount: buckets.length,
          type: 'MULTI_OUTCOME_BUCKETS',
          rationale: `Final price ${final} falls in bucket ${i} [${bucket.min}, ${bucket.max})`,
        };
      }
    }

    const last = buckets[buckets.length - 1];
    if (final >= last.min) {
      return {
        outcomeIndex: buckets.length - 1,
        outcomeCount: buckets.length,
        type: 'MULTI_OUTCOME_BUCKETS',
        rationale: `Final price ${final} falls in the unbounded top bucket ${buckets.length - 1} [${last.min}, ∞)`,
      };
    }

    throw new ConditionEvaluationError(
      'uncovered-range',
      `Final price ${final} is below every bucket (lowest starts at ${buckets[0].min}); the market cannot be settled`,
    );
  }
}

// ── Validation helpers ───────────────────────────────────────────────────────

/**
 * Maps the legacy `{ direction, targetPrice }` shape onto a condition type, so
 * markets indexed before the explicit `type` field existed keep resolving.
 */
function inferTypeFromLegacyShape(
  raw: Record<string, unknown>,
): string | undefined {
  const direction = raw.direction;
  if (direction === 'above') return 'ABOVE_PRICE';
  if (direction === 'below') return 'BELOW_PRICE';
  return undefined;
}

function requireFiniteNumber(
  raw: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = raw[field];
  if (value === undefined || value === null) {
    throw new ConditionEvaluationError(
      'missing-field',
      `${context} is missing required field "${field}"`,
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConditionEvaluationError(
      'invalid-field',
      `${context} field "${field}" must be a finite number, received ${describe(value)}`,
    );
  }
  return value;
}

/** `PERCENT_GAIN` thresholds are gains, so a negative one is a malformed market. */
function requireNonNegativePercent(
  raw: Record<string, unknown>,
  context: string,
): number {
  const percent = requireFiniteNumber(raw, 'percent', context);
  if (percent < 0) {
    throw new ConditionEvaluationError(
      'invalid-field',
      `${context} field "percent" must be >= 0, received ${percent}; ` +
        'use BELOW_PRICE for a "did it fall" market',
    );
  }
  return percent;
}

function requireUsablePrice(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConditionEvaluationError(
      'invalid-price',
      `${field} price must be a finite number, received ${describe(value)}`,
    );
  }
  if (value < 0) {
    throw new ConditionEvaluationError(
      'invalid-price',
      `${field} price must not be negative, received ${value}`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value))
    return String(value);
  if (typeof value === 'object')
    return Array.isArray(value) ? 'an array' : 'an object';
  return `${typeof value} (${String(value)})`;
}
