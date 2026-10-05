import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * twap-calculator.service.ts (BE-013)
 *
 * Outlier price detection.
 *
 * A single spot price is not a settlement price. A pool with $2k of liquidity
 * can be pushed 40% for one block by a flash loan, and a spoof trade can paint
 * a wick that never traded. If the oracle settled on that number, a market's
 * entire pot would be decided by a single manipulation.
 *
 * This service computes the Time-Weighted Average Price over a window of
 * 15-minute candles ending at the call's expiry and compares the spot price
 * against it. A spot that sits more than `ORACLE_TWAP_SIGMA_THRESHOLD`
 * (default 3) standard deviations away is flagged for human review instead of
 * being settled automatically.
 *
 * ── Integer basis-point arithmetic ───────────────────────────────────────────
 *
 * Prices arrive as floats, and float TWAP/stddev on a series of thin-liquidity
 * candles drifts exactly where it matters most — the difference between "3.0
 * sigma" (settle) and "3.1 sigma" (escalate) is a rounding artefact otherwise.
 * Every price is therefore converted once to a bigint of `PRICE_SCALE`
 * (1e8, i.e. 8 decimal places — five orders of magnitude finer than a cent and
 * comfortably inside the 2^53 / 2^64 budget for a token price) and all
 * sums, squares and roots are integer operations. Floats reappear only at the
 * public boundary, in `number` form, for logging and thresholds.
 */

/** Fixed-point scale: prices are held as `price * 1e8` bigints internally. */
const PRICE_SCALE_DECIMALS = 8;
const PRICE_SCALE = 10n ** BigInt(PRICE_SCALE_DECIMALS);

/** Thresholds are compared in thousandths, so 3.5σ is exact, not 3 or 4. */
const SIGMA_SCALE_MILLI = 1000n;

/** Guard digits carried through the 1.4826 ratio division. */
const RATIO_GUARD = 1_000_000n;

/**
 * Scale sigma is held at: prices x RATIO_GUARD. Finer than the price scale so
 * the 1.4826 factor does not truncate away.
 */
const SIGMA_SUB_SCALE = PRICE_SCALE * RATIO_GUARD;

/** One candle, as returned by a price-history provider. */
export interface Candle {
  /** Candle open time, unix **seconds**. */
  timestamp: number;
  /** Typical/trade price for the interval, in USD. */
  close: number;
  /** Optional volume for the interval; used for the liquidity check. */
  volume?: number;
}

/** Everything the TWAP filter concluded about one candidate price. */
export interface TwapVerdict {
  /** The verdict itself — false means "do not settle on this price". */
  accepted: boolean;
  /** Volume/time weighted average price over the window. */
  twap: number;
  /**
   * Scale the verdict was measured against: the robust (MAD-based) sigma.
   * A naive population sigma cannot be used here because the outlier being
   * detected inflates it — see `computeRobustStdDev`.
   */
  stdDev: number;
  /** Naive population sigma over the same window, for the audit record only. */
  populationStdDev: number;
  /** Signed distance of `spotPrice` from the TWAP, in sigmas. */
  sigmaDistance: number;
  /** Absolute distance in sigmas — the value compared against the threshold. */
  deviationSigmas: number;
  /** Threshold this verdict was measured against. */
  threshold: number;
  /** Candles that contributed to the window. */
  sampleSize: number;
  /** `windowStart`..`windowEnd` actually covered, after irregular-gap fixes. */
  windowStart: number;
  windowEnd: number;
  /** Why the price was rejected — surfaced in the audit log and admin alert. */
  reason?: TwapRejectionReason;
  /** Human-readable explanation, safe to put in a notification. */
  detail?: string;
}

export type TwapRejectionReason =
  | 'sigma-deviation'
  | 'insufficient-candles'
  | 'degenerate-window'
  | 'invalid-spot';

/** Thrown when a candle window cannot produce a meaningful TWAP. */
export class InsufficientCandleWindowError extends Error {
  constructor(
    public readonly reason: TwapRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'InsufficientCandleWindowError';
  }
}

/**
 * Fetches the candle window for a token. Kept as a seam so the service is
 * testable without a network, and so the provider (DexScreener, GeckoTerminal,
 * an internal indexer) can be swapped without touching the maths.
 */
export const CANDLE_SOURCE = Symbol('TWAP_CANDLE_SOURCE');

export interface CandleSource {
  fetchCandles(
    tokenAddress: string,
    windowStart: number,
    windowEnd: number,
  ): Promise<Candle[]>;
}

@Injectable()
export class TwapCalculatorService {
  private readonly logger = new Logger(TwapCalculatorService.name);

  /** Default window: 15-minute candles covering the 4 hours before expiry. */
  private readonly windowMs: number;
  private readonly candleIntervalSeconds: number;
  private readonly threshold: number;
  private readonly minCandles: number;

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(CANDLE_SOURCE)
    private readonly candleSource?: CandleSource,
  ) {
    this.windowMs = Number(
      this.config.get<string>('ORACLE_TWAP_WINDOW_MS') ?? 4 * 60 * 60 * 1000,
    );
    this.candleIntervalSeconds = Number(
      this.config.get<string>('ORACLE_TWAP_CANDLE_SECONDS') ?? 15 * 60,
    );
    this.threshold = Number(
      this.config.get<string>('ORACLE_TWAP_SIGMA_THRESHOLD') ?? 3,
    );
    this.minCandles = Number(
      this.config.get<string>('ORACLE_TWAP_MIN_CANDLES') ?? 4,
    );
  }

  /**
   * Computes the volume/time-weighted average price over `candles`.
   *
   * Weighting is *time*, not volume: a 15-minute candle in which nothing traded
   * carries exactly as much information about the market's price as a busy
   * one, and weighting by volume would let a single manipulation-heavy candle
   * dominate the very average meant to detect it. Candles are weighted by the
   * wall-clock duration they cover, which is also what makes the result correct
   * across irregularly-spaced history: a provider that returns one candle per
   * hour and one that returns four 15-minute candles covering the same span
   * produce the same TWAP.
   *
   * @throws InsufficientCandleWindowError when the window is too small or flat.
   */
  computeTwap(candles: Candle[]): number {
    return fromFixedPrice(this.twapFixed(candles));
  }

  /** Fixed-point form of `computeTwap`, for exact threshold compares. */
  private twapFixed(candles: Candle[]): bigint {
    const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    if (ordered.length === 0) {
      throw new InsufficientCandleWindowError(
        'insufficient-candles',
        'Cannot compute a TWAP from an empty candle window',
      );
    }

    let weightedSum = 0n;
    let totalWeight = 0n;

    for (let i = 0; i < ordered.length; i++) {
      const candle = ordered[i];
      const price = toFixedPrice(candle.close);
      if (price <= 0n) continue;

      // The final candle is bounded by one interval; every other candle runs to
      // the start of the next one, so a gap between two candles is charged to
      // the earlier one — the price the market actually held across that gap.
      const next = ordered[i + 1];
      const spanEnd = next
        ? Math.min(
            next.timestamp,
            candle.timestamp + this.candleIntervalSeconds,
          )
        : candle.timestamp + this.candleIntervalSeconds;

      const spanSeconds = spanEnd - candle.timestamp;
      if (spanSeconds <= 0) continue;

      weightedSum += price * BigInt(spanSeconds);
      totalWeight += BigInt(spanSeconds);
    }

    if (totalWeight === 0n) {
      throw new InsufficientCandleWindowError(
        'degenerate-window',
        'Candle window contains no positive-price interval with a non-zero time weight',
      );
    }

    return weightedSum / totalWeight;
  }

  /**
   * Population standard deviation of the window's prices, in USD.
   *
   * Population (divide by N) rather than sample (N-1): the window *is* the
   * population being modelled, and with as few as four candles the sample
   * correction inflates sigma by ~16% — enough to let a genuine 3-sigma
   * manipulation through.
   *
   * Reported for the audit trail, but **not** used for the decision — see
   * `computeRobustStdDev` for why a naive sigma is the wrong scale estimator
   * when the thing being detected is an outlier.
   */
  computeStdDev(candles: Candle[]): number {
    return fromFixedPrice(this.stdDevFixed(candles));
  }

  /** Fixed-point form of `computeStdDev`. */
  private stdDevFixed(candles: Candle[]): bigint {
    const prices = usablePrices(candles);

    if (prices.length < 2) {
      throw new InsufficientCandleWindowError(
        'insufficient-candles',
        `Standard deviation needs at least 2 priced candles, received ${prices.length}`,
      );
    }

    const n = BigInt(prices.length);
    const sum = prices.reduce((acc, p) => acc + p, 0n);
    const sumSq = prices.reduce((acc, p) => acc + p * p, 0n);

    // E[X^2] - (E[X])^2, in fixed point. Rounding each division once keeps the
    // result a bigint and makes the result deterministic for a given input.
    const mean = sum / n;
    const meanSq = sumSq / n - mean * mean;
    if (meanSq <= 0n) {
      throw new InsufficientCandleWindowError(
        'degenerate-window',
        'Candle prices have zero variance — sigma is undefined',
      );
    }

    return integerSqrt(meanSq);
  }

  /**
   * Robust scale estimate: 1.4826 x median-absolute-deviation about the median.
   *
   * This is the scale actually used to judge an outlier, and the reason is the
   * whole point of the service. A population sigma computed *over a window
   * that contains the manipulation* is inflated by the manipulation: a $100
   * market that prints $900 for one candle has a population sigma of ~$320, so
   * the spike lands only ~2 sigma from the mean and sails through a 3-sigma
   * gate. The filter would be defeated by the very event it exists to catch.
   *
   * The MAD estimator is unmoved by a minority of extreme prints — one poisoned
   * candle in six leaves it bit-identical — so the spike stays a >400 sigma
   * event no matter how extreme it is. The 1.4826 factor makes MAD a consistent
   * estimator of sigma for normally distributed data, so the ">3 sigma" wording
   * keeps its usual meaning on a well-behaved market. On a smooth, uniformly
   * spread price path MAD over-estimates sigma by up to ~2x and the gate is
   * correspondingly looser; that is a deliberate, documented trade-off.
   *
   * Still integer arithmetic: median, absolute deviations and the scale factor
   * are all bigint, with a single final division.
   */
  computeRobustStdDev(candles: Candle[]): number {
    return fromSubUnits(this.robustStdDevSub(candles));
  }

  /**
   * Fixed-point form of `computeRobustStdDev`, in `SIGMA_SUB_SCALE` units.
   *
   * Returned at a finer scale than prices on purpose: sigma is produced by a
   * 1.4826x multiplication, and at the price scale a one-tick MAD truncates
   * 1.4826 ticks down to 1 tick — a 32% error on the exact quantity the
   * accept/reject decision is measured against.
   */
  private robustStdDevSub(candles: Candle[]): bigint {
    const prices = usablePrices(candles);

    if (prices.length < 2) {
      throw new InsufficientCandleWindowError(
        'insufficient-candles',
        `Robust standard deviation needs at least 2 priced candles, received ${prices.length}`,
      );
    }

    const median = medianOf(prices);
    const deviations = prices.map((p) =>
      p > median ? p - median : median - p,
    );
    const mad = medianOf(deviations);

    if (mad === 0n) {
      throw new InsufficientCandleWindowError(
        'degenerate-window',
        'Candle prices have zero dispersion — sigma is undefined',
      );
    }

    // 1.4826 as the exact ratio 7413/5000, carried at RATIO_GUARD relative
    // precision before it is folded back into sub-units.
    return (mad * RATIO_GUARD * 7413n) / 5000n;
  }

  /**
   * Decides whether `spotPrice` is a legitimate settlement price for a call
   * that expired at `expiryTs`.
   *
   * Accepts the price when it sits within `threshold` sigmas of the TWAP.
   * Rejects it — for human review — when it deviates further, when the history
   * is too thin to judge, or when the price is not a usable number.
   *
   * Never throws for a bad *price*: an outlier is an expected, routine event,
   * and the caller's response (freeze and alert) must not be an exception.
   */
  async evaluate(
    tokenAddress: string,
    spotPrice: number,
    expiryTs: number,
    candles?: Candle[],
  ): Promise<TwapVerdict> {
    const threshold = this.threshold;
    const windowStart = Math.floor(expiryTs - this.windowMs / 1000);

    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      return this.reject(
        'invalid-spot',
        threshold,
        0,
        windowStart,
        expiryTs,
        `Spot price ${spotPrice} is not a usable USD price`,
      );
    }

    let window: Candle[];
    try {
      window =
        candles ??
        (await this.fetchWindow(tokenAddress, windowStart, expiryTs));
    } catch (err) {
      // A provider outage must not be silently treated as "price is fine".
      this.logger.error(
        `Candle fetch failed for ${tokenAddress}: ${(err as Error).message}`,
      );
      return this.reject(
        'insufficient-candles',
        threshold,
        0,
        windowStart,
        expiryTs,
        `Price history unavailable: ${(err as Error).message}`,
      );
    }

    return this.evaluateWithCandles(window, spotPrice, threshold);
  }

  /**
   * Pure verdict for an already-fetched window. Split out from `evaluate` so
   * the decision logic is testable without a candle provider, and so a caller
   * that already has the history (e.g. the resolution sweep) does not refetch.
   */
  evaluateWithCandles(
    candles: Candle[],
    spotPrice: number,
    threshold = this.threshold,
  ): TwapVerdict {
    const windowStart = candles.length
      ? Math.min(...candles.map((c) => c.timestamp))
      : 0;
    const windowEnd = candles.length
      ? Math.max(...candles.map((c) => c.timestamp))
      : 0;

    if (candles.length < this.minCandles) {
      return this.reject(
        'insufficient-candles',
        threshold,
        candles.length,
        windowStart,
        windowEnd,
        `Only ${candles.length} candle(s) in the window; at least ${this.minCandles} are required to judge an outlier`,
      );
    }

    let twapFixed: bigint;
    let stdDevSub: bigint;
    let populationStdDevFixed: bigint;
    try {
      twapFixed = this.twapFixed(candles);
      stdDevSub = this.robustStdDevSub(candles);
      // Best-effort: a flat window has no population sigma either, and the
      // robust path already threw for that case above.
      populationStdDevFixed = this.stdDevFixed(candles);
    } catch (err) {
      return this.reject(
        (err as InsufficientCandleWindowError).reason ?? 'degenerate-window',
        threshold,
        candles.length,
        windowStart,
        windowEnd,
        (err as Error).message,
      );
    }

    const stdDev = fromSubUnits(stdDevSub);
    const spotFixed = toFixedPrice(spotPrice);
    const signedDeviation = spotFixed - twapFixed;
    // Both sides of the ratio have to be in the same (USD) unit: the deviation
    // comes out of price fixed-point, sigma out of the finer sub-scale.
    const deviationUsd = fromFixedPrice(signedDeviation);
    const deviationSigmas = Math.abs(deviationUsd) / stdDev;
    // Signed, so callers can tell a pump from a dump without re-deriving it.
    const sigmaDistance = deviationUsd / stdDev;

    const base = this.base(
      fromFixedPrice(twapFixed),
      stdDev,
      fromFixedPrice(populationStdDevFixed),
      sigmaDistance,
      deviationSigmas,
      threshold,
      candles.length,
      windowStart,
      windowEnd,
    );

    // The accept/reject decision itself is made in fixed point:
    //   |spot - twap| * 1000  >  sigma * thresholdMilli
    // Comparing floats here would put "exactly 3 sigma" on the wrong side of
    // the gate about half the time, which is a coin flip on whether a market
    // settles or freezes.
    const thresholdMilli = BigInt(Math.round(threshold * 1000));
    const beyondThreshold =
      toSubUnits(absBigInt(signedDeviation)) * SIGMA_SCALE_MILLI >
      stdDevSub * thresholdMilli;

    if (beyondThreshold) {
      const direction = signedDeviation > 0n ? 'above' : 'below';
      return {
        ...base,
        accepted: false,
        reason: 'sigma-deviation',
        detail:
          `Spot $${spotPrice} is ${deviationSigmas.toFixed(2)}σ ${direction} the ` +
          `${this.windowMs / 60000}-minute TWAP of $${fromFixedPrice(twapFixed)} (σ = $${stdDev}), ` +
          `exceeding the ${threshold}σ threshold — possible flash loan or spoof trade`,
      };
    }

    return {
      ...base,
      accepted: true,
      detail: `Spot $${spotPrice} is ${deviationSigmas.toFixed(2)}σ from the TWAP of $${fromFixedPrice(twapFixed)} (σ = $${stdDev})`,
    };
  }

  /** Total traded volume in the window — the liquidity leg of the safety check. */
  sumVolume(candles: Candle[]): number {
    return candles.reduce((acc, c) => acc + (Number(c.volume) || 0), 0);
  }

  private base(
    twap: number,
    stdDev: number,
    populationStdDev: number,
    sigmaDistance: number,
    deviationSigmas: number,
    threshold: number,
    sampleSize: number,
    windowStart: number,
    windowEnd: number,
  ): TwapVerdict {
    return {
      accepted: true,
      twap,
      stdDev,
      populationStdDev,
      sigmaDistance,
      deviationSigmas,
      threshold,
      sampleSize,
      windowStart,
      windowEnd,
    };
  }

  private reject(
    reason: TwapRejectionReason,
    threshold: number,
    sampleSize: number,
    windowStart: number,
    windowEnd: number,
    detail: string,
  ): TwapVerdict {
    return {
      accepted: false,
      twap: 0,
      stdDev: 0,
      populationStdDev: 0,
      sigmaDistance: 0,
      deviationSigmas: 0,
      threshold,
      sampleSize,
      windowStart,
      windowEnd,
      reason,
      detail,
    };
  }

  private async fetchWindow(
    tokenAddress: string,
    windowStart: number,
    windowEnd: number,
  ): Promise<Candle[]> {
    if (!this.candleSource) {
      throw new InsufficientCandleWindowError(
        'insufficient-candles',
        'No CANDLE_SOURCE is registered — TWAP history cannot be fetched',
      );
    }
    this.logger.log(
      `Fetching ${tokenAddress} candles for [${windowStart}, ${windowEnd}]`,
    );
    return this.candleSource.fetchCandles(tokenAddress, windowStart, windowEnd);
  }
}

/** Absolute value for bigints, which have no `Math.abs`. */
function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * The window's usable prices in fixed point, dropping anything that is not a
 * positive finite number so one garbage candle cannot poison a sum. The window
 * shrink this causes stays visible to the caller via `sampleSize`.
 */
function usablePrices(candles: Candle[]): bigint[] {
  return candles.map((c) => toFixedPrice(c.close)).filter((p) => p > 0n);
}

/**
 * Converts a USD price to fixed-point bigint at `PRICE_SCALE_DECIMALS`.
 *
 * Rejects NaN/Infinity and non-positive values to 0n, so a single garbage
 * candle cannot poison a sum — the caller filters those out and the resulting
 * window shrink is visible in `sampleSize`.
 */
function toFixedPrice(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) return 0n;
  // Math.round on the scaled float: JS number multiplication stays exact to
  // ~15 significant digits, and 1e8 scaling leaves plenty of headroom.
  return BigInt(Math.round(price * Number(PRICE_SCALE)));
}

/** Converts a fixed-point bigint back to a USD number. */
function fromFixedPrice(value: bigint): number {
  return Number(value) / Number(PRICE_SCALE);
}

/** Widens a price fixed-point value into the finer sigma sub-scale. */
function toSubUnits(value: bigint): bigint {
  return value * RATIO_GUARD;
}

/** Narrows a sigma sub-scale value back to USD. */
function fromSubUnits(value: bigint): number {
  return Number(value) / Number(SIGMA_SUB_SCALE);
}

/**
 * Median of a bigint array. Sorts a copy so no caller can get the answer wrong
 * by handing over unsorted input, and averages the two middle values for an
 * even-length input so a 4-candle window still yields an exact centre.
 *
 * The average rounds half *up* rather than truncating: these are prices and
 * deviations, never negative, and truncating would collapse a genuine
 * half-unit spread (two candles one tick apart) to a flat zero.
 */
function medianOf(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid] + 1n) / 2n;
}

/**
 * Integer square root (Newton's method) — the last float-free step before the
 * verdict, so two runs over the same candles always produce the same sigma.
 */
function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('integerSqrt of a negative value');
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}
