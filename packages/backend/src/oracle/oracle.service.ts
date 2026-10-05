import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ethers } from 'ethers';
import { Keypair } from '@stellar/stellar-sdk';
import * as nacl from 'tweetnacl';
import { AdminService } from '../admin/admin.service';
import { RedisClientProvider, IRedisClient } from '../config/redis.config';
import { IpfsService } from '../ipfs/ipfs.service';
import { Call } from '../calls/call.entity';
import { AuditLog, AuditLogAction } from './audit-log.entity';
import { IKeySigner, LocalWalletSigner, KmsSigner } from './key-signer';
import {
  IStellarKeySigner,
  KmsEd25519Signer,
  LocalEd25519Signer,
  StellarResolutionPayload,
  StellarSignature,
  assertValidResolutionPayload,
  buildCanonicalResolutionPayload,
  digestResolutionPayload,
} from './key-signer';
import {
  QuorumConsensusService,
  ResolutionPayload,
} from './quorum-consensus.service';
import {
  PriceFreshness,
  PriceStalenessService,
  StalenessViolation,
} from './price-staleness.service';
import { LedgerSchedulerService } from './ledger-scheduler.service';
import {
  AggregatedPrice,
  PriceProvider,
  PRICE_PROVIDERS,
  PriceQuote,
  confidenceForProviderCount,
} from './providers/price-provider.interface';

// ─── Retry configuration ────────────────────────────────────────────────────

interface RetryOptions {
  maxAttempts?: number; // total attempts including the first call (default: 4)
  baseDelayMs?: number; // initial backoff in ms                   (default: 1000)
  factor?: number; // exponential growth factor               (default: 2)
  maxDelayMs?: number; // ceiling on any single delay             (default: 30_000)
  jitter?: number; // ±fraction of delay to randomise         (default: 0.2)
  operationName?: string; // label used in log lines
}

// Thrown when every retry attempt has been exhausted
export class RpcExhaustedError extends Error {
  constructor(
    public readonly operation: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(
      `"${operation}" failed after ${attempts} attempt(s): ${lastError.message}`,
    );
    this.name = 'RpcExhaustedError';
  }
}

/**
 * withRetry — exponential-backoff retry engine.
 *
 * Backoff schedule (defaults):
 *   Attempt 1 → immediate
 *   Attempt 2 → ~1 000 ms
 *   Attempt 3 → ~2 000 ms
 *   Attempt 4 → ~4 000 ms  → throws RpcExhaustedError
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  logger?: Logger,
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 1_000,
    factor = 2,
    maxDelayMs = 30_000,
    jitter = 0.2,
    operationName = 'operation',
  } = options;

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) break;

      const raw = Math.min(
        baseDelayMs * Math.pow(factor, attempt - 1),
        maxDelayMs,
      );
      const delay = Math.max(
        0,
        Math.round(raw + raw * jitter * (Math.random() * 2 - 1)),
      );

      logger?.warn(
        `[${operationName}] attempt ${attempt}/${maxAttempts} failed — ` +
          `retrying in ${delay}ms. Reason: ${lastError.message}`,
      );

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new RpcExhaustedError(operationName, maxAttempts, lastError);
}

// ─── Retryable method decorator ─────────────────────────────────────────────

/**
 * @Retryable(maxAttempts) — decorates any async method with retry + backoff.
 *
 * @example
 * @Retryable(3)
 * async fetchPrice(token: string): Promise<number> { ... }
 *
 * @example
 * @Retryable({ maxAttempts: 5, baseDelayMs: 500 })
 * async callSorobanRpc(): Promise<string> { ... }
 */
export function Retryable(optionsOrAttempts: number | RetryOptions) {
  const options: RetryOptions =
    typeof optionsOrAttempts === 'number'
      ? { maxAttempts: optionsOrAttempts }
      : optionsOrAttempts;

  return function (
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const className = target.constructor?.name ?? 'Unknown';
    const operationName =
      options.operationName ?? `${className}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      // Use the instance logger if available (NestJS services have this.logger)
      const logger: Logger | undefined = (this as { logger?: Logger }).logger;
      return withRetry(
        () => original.apply(this, args),
        { ...options, operationName },
        logger,
      );
    };

    Object.defineProperty(descriptor.value, 'name', { value: propertyKey });
    return descriptor;
  };
}

// ─── DexScreener response shape ─────────────────────────────────────────────

interface DexScreenerResponse {
  pairs: Array<{
    priceUsd: string;
    baseToken: { symbol: string };
    volume: { h24: number };
    liquidity: { usd: number };
  }>;
}

// ─── GeckoTerminal response shape (BE-01 fallback fetcher) ─────────────────

interface GeckoTerminalResponse {
  data?: {
    attributes?: {
      token_prices?: Record<string, string>;
      /**
       * ISO timestamp of the quoted price. DexScreener's token-pairs endpoint
       * has no equivalent, which is why PriceStalenessService also tracks
       * price change locally.
       */
      updated_at?: string;
    };
  };
}

/** Thrown when both DexScreener and GeckoTerminal are exhausted. */
export class PriceFeedOutageError extends Error {
  constructor(
    public readonly tokenAddress: string,
    public readonly dexScreenerError: Error,
    public readonly geckoTerminalError: Error,
  ) {
    super(
      `All price feeds exhausted for ${tokenAddress}. ` +
        `DexScreener: ${dexScreenerError.message}; GeckoTerminal: ${geckoTerminalError.message}`,
    );
    this.name = 'PriceFeedOutageError';
  }
}

export interface EvidencePayload {
  callId: number;
  tokenAddress: string;
  chain: string;
  source: 'dexscreener' | 'geckoterminal';
  price: number;
  scaledPrice: string;
  outcome: boolean;
  conditionJson: unknown;
  resolvedAt: string;
}

export interface ResolutionResult {
  callId: number;
  status: 'SETTLED' | 'UNRESOLVED' | 'RESOLUTION_HALTED';
  outcome?: boolean;
  finalPrice?: number;
  evidenceCid?: string;
  oracleSignature?: string;
  /** Populated when the call was frozen (BE-018). */
  haltedReason?: string;
}

/**
 * What a quorum-assisted signing attempt produced (BE-017).
 *
 * On `converged: false` nothing is signed: the caller aborts the submission
 * rather than sending a signature the other nodes did not agree to.
 */
export interface QuorumOutcomeResult {
  converged: boolean;
  /** The aggregated signature set, present only when the threshold was reached. */
  signature?: string;
  aggregate?: string;
  signers?: string[];
  signatures?: string[];
  payloadHash?: string;
  threshold?: number;
  nodeCount?: number;
  latencyMs?: number;
  reason?:
    | 'timeout'
    | 'no-nodes'
    | 'no-transport'
    | 'no-quorum-service'
    | 'unknown';
  rejections?: { reason: string; signature: string; detail?: string }[];
}

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class OracleService implements OnModuleInit {
  private readonly logger = new Logger(OracleService.name);

  private readonly priceProviders: PriceProvider[];
  private readonly redisClientProvider?: RedisClientProvider;
  private readonly inMemoryPriceCache = new Map<
    string,
    { value: AggregatedPrice; expiresAt: number }
  >();

  private get redisClient(): IRedisClient | null {
    return this.redisClientProvider?.getClient() ?? null;
  }

  private static readonly PRICE_CACHE_TTL_MS = 10_000;
  private static readonly PRICE_CACHE_PREFIX = 'oracle:price:';
  private static readonly MAX_QUOTE_AGE_MS = 5 * 60 * 1000;
  private static readonly OUTLIER_DEVIATION = 0.1;

  private signer: ethers.Wallet;
  private stellarKeypair: Keypair;

  /** KMS/local abstraction used by signEIP712() — see key-signer.ts (BE-02). */
  private activeSigner?: IKeySigner;

  /**
   * BE-12: ed25519 signer for Soroban submissions. An HSM/KMS-backed signer in
   * production (`STELLAR_KMS_URL` set — no secret key ever enters this
   * process), the local secret key in development.
   */
  private activeStellarSigner?: IStellarKeySigner;

  /** Reports where the ed25519 key lives, for audit logs and the admin API. */
  get stellarSignerKind(): 'local' | 'hsm' | 'none' {
    return this.activeStellarSigner?.kind ?? 'none';
  }

  constructor(
    private configService: ConfigService,
    private adminService: AdminService,
    @Optional() @Inject(PRICE_PROVIDERS) priceProviders?: PriceProvider[],
    @Optional()
    @Inject(RedisClientProvider)
    redisClientProvider?: RedisClientProvider,
    @Optional() private readonly ipfsService?: IpfsService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @InjectRepository(Call)
    private readonly callRepository?: Repository<Call>,
    @Optional()
    @InjectRepository(AuditLog)
    private readonly auditLogRepository?: Repository<AuditLog>,
    @Optional() private readonly dataSource?: DataSource,
    /**
     * BE-017: the M-of-N consensus engine. Optional so the service keeps
     * working in a single-node deployment; `signOutcomeWithQuorum` refuses to
     * sign when it is absent rather than pretending consensus happened.
     */
    @Optional() private readonly quorum?: QuorumConsensusService,
    /**
     * BE-018: the staleness guard. Optional so existing deployments and tests
     * keep resolving; when present, a call is frozen rather than settled on a
     * price that is stale or untradeable.
     */
    @Optional() private readonly priceStaleness?: PriceStalenessService,
    /**
     * BE-020: ledger-aware expiry scheduling. Optional so a deployment without
     * the scheduler falls back to the interval sweep below rather than
     * silently never resolving.
     */
    @Optional() private readonly ledgerScheduler?: LedgerSchedulerService,
  ) {
    this.priceProviders = priceProviders ?? [];
    this.redisClientProvider = redisClientProvider;

    const privateKey = this.configService.get<string>('ORACLE_PRIVATE_KEY');
    if (privateKey) {
      this.signer = new ethers.Wallet(privateKey);
    }

    const stellarSecretKey = this.configService.get<string>(
      'STELLAR_ORACLE_SECRET_KEY',
    );
    if (stellarSecretKey) {
      this.stellarKeypair = Keypair.fromSecret(stellarSecretKey);
    }

    const kmsUrl = this.configService.get<string>('KMS_URL');
    if (kmsUrl) {
      this.activeSigner = new KmsSigner(
        kmsUrl,
        this.configService.get<string>('KMS_KEY_ID', ''),
        this.configService.get<string>('KMS_API_TOKEN'),
      );
    } else if (privateKey) {
      this.activeSigner = new LocalWalletSigner(privateKey);
    }

    // BE-12: an HSM/KMS signer wins over the in-process secret key so a
    // production deployment can be configured to *refuse* to hold a seed.
    const stellarKmsUrl = this.configService.get<string>('STELLAR_KMS_URL');
    if (stellarKmsUrl) {
      this.activeStellarSigner = new KmsEd25519Signer(
        stellarKmsUrl,
        this.configService.get<string>('STELLAR_KMS_KEY_ID', ''),
        this.configService.get<string>('STELLAR_KMS_API_TOKEN'),
      );
      this.logger.log(
        'Stellar oracle signing delegated to an external HSM/KMS — ' +
          'no ed25519 secret key is held in this process',
      );
    } else if (stellarSecretKey) {
      this.activeStellarSigner = new LocalEd25519Signer(stellarSecretKey);
    }
  }

  // ─── Ledger-aware scheduling (BE-020) ────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.ledgerScheduler) return;

    // The scheduler owns *when*; this service still owns *what*. Handing it the
    // existing sweep means a closed ledger resolves exactly the calls the
    // ordinary path would have, and the safety checks inside are unchanged.
    this.ledgerScheduler.setDueHandler(async () => {
      await this.resolveDueCalls();
    });

    // The in-process queue is not durable, so a restart would otherwise forget
    // every pending target. Re-arm from the database instead.
    await this.armUpcomingCalls();
  }

  /**
   * Give every call that is approaching its expiry a target ledger.
   *
   * Runs on boot and on an interval, because a call created after startup still
   * needs arming, and because the horizon means a call is always picked up well
   * before it is due.
   */
  @Interval('oracle-ledger-arm', 60_000)
  async armUpcomingCalls(): Promise<number> {
    if (!this.ledgerScheduler || !this.callRepository) return 0;

    const horizonHours = this.configService.get<number>(
      'LEDGER_SCHEDULE_HORIZON_HOURS',
      6,
    );
    const limit = this.configService.get<number>(
      'LEDGER_SCHEDULE_BATCH_SIZE',
      200,
    );
    const until = new Date(Date.now() + horizonHours * 60 * 60 * 1_000);

    const upcoming = await this.callRepository.find({
      where: { status: 'OPEN' },
      order: { endTs: 'ASC' },
      take: limit,
    });

    let armed = 0;
    for (const call of upcoming) {
      const endTsMs = new Date(call.endTs).getTime();
      if (!Number.isFinite(endTsMs)) continue;
      if (new Date(call.endTs) > until) continue;
      // null means the scheduler had no ledger to anchor a target to. The call
      // is not armed, but it is also not lost: the due-call sweep still
      // resolves it, and the next arm pass will get a real target.
      const scheduled = await this.ledgerScheduler.scheduleCall(
        call.id,
        endTsMs,
      );
      if (scheduled) armed += 1;
    }
    return armed;
  }

  /**
   * Safety net for calls the ledger scheduler did not resolve.
   *
   * The scheduler has deliberate failure paths: it declines to arm a call when
   * no ledger has been observed, and it gives up on a call whose target ledger
   * has not closed within `LEDGER_CONFIRM_TIMEOUT_MS`. Without a fallback those
   * calls would sit at OPEN forever, because the scheduler is otherwise the only
   * automatic resolution path.
   *
   * It is a sweep rather than a second scheduler on purpose: it resolves
   * whatever is past `endTs` and nothing else. Precision is lost — this path
   * cannot target a ledger — but BE-018's staleness guard runs inside
   * `resolveOneCall` either way, so a call lands here on bad data is frozen
   * rather than settled. Precision is a scheduling nicety; settling on a stale
   * price is the actual harm.
   *
   * Running alongside the scheduler is safe: `resolveDueCalls` claims rows with
   * `FOR UPDATE SKIP LOCKED` and flips them to SETTLING before doing any work,
   * so the two paths cannot settle the same call.
   */
  @Interval('oracle-due-sweep', 60_000)
  async sweepDueCalls(): Promise<number> {
    if (!this.ledgerScheduler) {
      // No scheduler wired up: this sweep is the only resolution path there is,
      // so it has to run.
      return this.runDueSweep();
    }
    const results = await this.runDueSweep();
    if (results > 0) {
      this.logger.warn(
        `${results} due call(s) resolved by the fallback sweep rather than ` +
          'the ledger scheduler',
      );
    }
    return results;
  }

  private async runDueSweep(): Promise<number> {
    if (!this.dataSource || !this.callRepository) return 0;
    try {
      const results = await this.resolveDueCalls();
      return results.length;
    } catch (err) {
      this.logger.error(
        `Due-call sweep failed: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  // ─── Public key helpers ────────────────────────────────────────────────────

  /**
   * Get the Stellar public key for contract authorization.
   */
  getStellarPublicKey(): string {
    if (!this.stellarKeypair) {
      throw new Error('Stellar keypair not configured');
    }
    return this.stellarKeypair.publicKey();
  }

  // ─── Price fetching ───────────────────────────────────────────────────────

  /**
   * Fetches a price *and* the evidence needed to judge whether it can settle a
   * market (BE-018).
   *
   * DexScreener reports 24h volume but no observation time, so the timestamp is
   * left undefined and `PriceStalenessService` falls back to locally-observed
   * price change.
   *
   * Retried automatically with exponential backoff:
   *   attempt 1 → immediate
   *   attempt 2 → ~1 s
   *   attempt 3 → ~2 s
   *   attempt 4 → ~4 s → throws RpcExhaustedError
   */
  @Retryable({
    maxAttempts: 4,
    baseDelayMs: 1_000,
    operationName: 'oracle:fetchPrice',
  })
  async fetchQuote(tokenAddress: string): Promise<PriceFreshness> {
    this.logger.log(`Fetching price for ${tokenAddress}`);

    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000), // 8 s hard timeout per attempt
    });

    if (!response.ok) {
      throw new Error(
        `DexScreener responded ${response.status} ${response.statusText} for ${tokenAddress}`,
      );
    }

    const data = (await response.json()) as DexScreenerResponse;

    const pair = data?.pairs?.[0];
    if (!pair?.priceUsd) {
      throw new Error(
        `No price data returned by DexScreener for ${tokenAddress}`,
      );
    }

    const price = parseFloat(pair.priceUsd);
    this.logger.log(
      `Price fetched for ${tokenAddress}: $${price} ` +
        `(${pair.baseToken.symbol}, 24h vol: $${pair.volume.h24})`,
    );

    return {
      price,
      volume24h: pair.volume?.h24,
      source: 'dexscreener',
    };
  }

  /**
   * Fetches the USD price for a token via the DexScreener API.
   *
   * Thin wrapper over {@link fetchQuote} for callers that only need the number.
   * The retry policy lives on `fetchQuote` so both entry points get it.
   */
  async fetchPrice(tokenAddress: string): Promise<number> {
    const quote = await this.fetchQuote(tokenAddress);
    return quote.price;
  }

  /**
   * Fetch price with a graceful fallback — returns null instead of throwing
   * when all retry attempts are exhausted. Use this when a missing price should
   * degrade gracefully rather than crash the caller.
   */
  async fetchPriceSafe(tokenAddress: string): Promise<number | null> {
    try {
      return await this.fetchPrice(tokenAddress);
    } catch (err) {
      if (err instanceof RpcExhaustedError) {
        this.logger.error(
          `oracle:fetchPrice exhausted after ${err.attempts} attempts for ` +
            `${tokenAddress} — ${err.lastError.message}`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * GeckoTerminal quote, with the API's own `updated_at` as freshness evidence.
   *
   * GeckoTerminal's simple-price endpoint reports no volume, so the liquidity
   * check falls back to failing closed when this feed is the only one left.
   */
  @Retryable({
    maxAttempts: 3,
    baseDelayMs: 1_000,
    operationName: 'oracle:fetchFromGeckoTerminal',
  })
  async fetchGeckoQuote(
    tokenAddress: string,
    network?: string,
  ): Promise<PriceFreshness> {
    const net =
      network ??
      this.configService.get<string>('GECKOTERMINAL_NETWORK', 'base');
    const url = `https://api.geckoterminal.com/api/v2/simple/networks/${net}/token_price/${tokenAddress}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(
        `GeckoTerminal responded ${response.status} ${response.statusText} for ${tokenAddress}`,
      );
    }

    const data = (await response.json()) as GeckoTerminalResponse;
    const prices = data?.data?.attributes?.token_prices;
    const raw = prices?.[tokenAddress.toLowerCase()] ?? prices?.[tokenAddress];

    if (!raw) {
      throw new Error(
        `No price data returned by GeckoTerminal for ${tokenAddress}`,
      );
    }

    const price = parseFloat(raw);
    // An unparseable updated_at is dropped rather than turned into NaN, so the
    // staleness check falls back to price-change evidence instead of
    // comparing against a non-finite timestamp.
    const updatedAtRaw = data?.data?.attributes?.updated_at;
    const updatedAt = updatedAtRaw
      ? Date.parse(updatedAtRaw)
      : Number.NaN;

    this.logger.log(
      `GeckoTerminal fallback price for ${tokenAddress}: $${price}` +
        (Number.isFinite(updatedAt) ? ` (as of ${updatedAtRaw})` : ''),
    );

    return {
      price,
      timestamp: Number.isFinite(updatedAt) ? updatedAt : undefined,
      source: 'geckoterminal',
    };
  }

  /**
   * Fetches the USD price for a token via GeckoTerminal's simple price API.
   * Used as the fallback fetcher when DexScreener is unavailable (BE-01).
   */
  async fetchFromGeckoTerminal(
    tokenAddress: string,
    network?: string,
  ): Promise<number> {
    const quote = await this.fetchGeckoQuote(tokenAddress, network);
    return quote.price;
  }

  /**
   * DexScreener → GeckoTerminal fallback chain (BE-01, extended BE-018).
   *
   * Returns the price together with the evidence needed to judge whether it
   * may settle a market. Only throws PriceFeedOutageError once *both* feeds
   * are exhausted, which callers should treat as an UNRESOLVED signal.
   */
  async fetchPriceWithFallback(
    tokenAddress: string,
    network?: string,
  ): Promise<PriceFreshness & { source: 'dexscreener' | 'geckoterminal' }> {
    try {
      const quote = await this.fetchQuote(tokenAddress);
      return { ...quote, source: 'dexscreener' };
    } catch (dexErr) {
      const dexError =
        dexErr instanceof Error ? dexErr : new Error(String(dexErr));
      this.logger.warn(
        `DexScreener exhausted for ${tokenAddress}, falling back to GeckoTerminal: ${dexError.message}`,
      );

      try {
        const quote = await this.fetchGeckoQuote(tokenAddress, network);
        return { ...quote, source: 'geckoterminal' };
      } catch (geckoErr) {
        const geckoError =
          geckoErr instanceof Error ? geckoErr : new Error(String(geckoErr));
        throw new PriceFeedOutageError(tokenAddress, dexError, geckoError);
      }
    }
  }

  /** Scales a USD float price into an integer string per ORACLE_PRICE_SCALE (default 1e18). */
  scalePrice(price: number): string {
    const scale = BigInt(
      this.configService.get<string>(
        'ORACLE_PRICE_SCALE',
        '1000000000000000000',
      ),
    );
    // Work in integer cents-of-scale to avoid floating point drift, then
    // apply the remaining scale as a BigInt multiplication.
    const PRECISION = 1_000_000; // 6 decimal places of the input float
    const scaledFloat = BigInt(Math.round(price * PRECISION));
    return ((scaledFloat * scale) / BigInt(PRECISION)).toString();
  }

  // ─── Call resolution orchestrator (BE-01) ──────────────────────────────────

  /**
   * Resolves every due call (`status = 'OPEN' AND endTs <= now()`), one
   * database row at a time, guarded by `FOR UPDATE SKIP LOCKED` so multiple
   * OracleService instances/replicas can run this sweep concurrently
   * without double-settling a call.
   *
   * For each due call:
   *   1. Fetch price via DexScreener → GeckoTerminal fallback.
   *      - On total outage: mark UNRESOLVED, notify admins, audit-log, continue.
   *   2. Determine outcome from `conditionJson` (`{ direction, targetPrice }`).
   *   3. Pin an evidence JSON blob to IPFS.
   *   4. Sign the outcome for the call's chain (EIP-712 or ed25519).
   *   5. Persist SETTLED + emit `oracle.settlement`.
   */
  async resolveDueCalls(batchSize?: number): Promise<ResolutionResult[]> {
    if (!this.dataSource || !this.callRepository) {
      throw new Error(
        'OracleService.resolveDueCalls requires DataSource and Call repository to be injected',
      );
    }

    const limit =
      batchSize ??
      this.configService.get<number>('ORACLE_RESOLUTION_BATCH_SIZE', 20);

    const results: ResolutionResult[] = [];

    await this.dataSource.transaction(async (manager) => {
      const dueRows: Call[] = await manager.query(
        `SELECT * FROM "call"
           WHERE status = 'OPEN' AND "endTs" <= NOW()
           ORDER BY "endTs" ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      for (const row of dueRows) {
        const call = manager.create(Call, row);
        // Claim the row immediately so a crash mid-loop doesn't leave it
        // silently re-picked as OPEN by the next sweep.
        call.status = 'SETTLING';
        await manager.save(Call, call);

        try {
          const result = await this.resolveOneCall(call, manager);
          results.push(result);
        } catch (err) {
          this.logger.error(
            `Unexpected error resolving call ${call.id}: ${(err as Error).message}`,
          );
          call.status = 'UNRESOLVED';
          await manager.save(Call, call);
          await this.recordUnresolved(call, err as Error, manager);
          results.push({ callId: call.id, status: 'UNRESOLVED' });
        }
      }
    });

    return results;
  }

  private async resolveOneCall(
    call: Call,
    manager: import('typeorm').EntityManager,
  ): Promise<ResolutionResult> {
    let quote: PriceFreshness & {
      source: 'dexscreener' | 'geckoterminal';
    };
    try {
      quote = await this.fetchPriceWithFallback(call.tokenAddress);
    } catch (err) {
      call.status = 'UNRESOLVED';
      await manager.save(Call, call);
      await this.recordUnresolved(call, err as Error, manager);
      return { callId: call.id, status: 'UNRESOLVED' };
    }

    // ── BE-018: refuse to settle on a price we cannot trust ───────────────
    // Done before any evidence is pinned or signature is produced, so a
    // frozen call leaves no signature and no IPFS pin that a later step could
    // mistake for a completed resolution.
    const resolutionAtMs = call.endTs
      ? new Date(call.endTs).getTime()
      : Date.now();
    const changedAtMs = this.priceStaleness
      ? this.priceStaleness.observePriceChange(call.tokenAddress, quote.price)
      : undefined;

    const verdict = this.priceStaleness
      ? this.priceStaleness.evaluate({ ...quote, changedAtMs }, resolutionAtMs)
      : { fresh: true, violations: [] };

    if (!verdict.fresh) {
      return this.haltResolution(call, verdict.violations, manager);
    }

    const { price, source } = quote;
    const outcome = this.determineOutcome(call, price);
    const scaledPrice = this.scalePrice(price);

    const evidence: EvidencePayload = {
      callId: call.id,
      tokenAddress: call.tokenAddress,
      chain: call.chain,
      source,
      price,
      scaledPrice,
      outcome,
      conditionJson: call.conditionJson,
      resolvedAt: new Date().toISOString(),
    };

    let evidenceCid: string | undefined;
    if (this.ipfsService) {
      try {
        evidenceCid = await this.ipfsService.pin(
          Buffer.from(JSON.stringify(evidence, null, 2)),
          `evidence-call-${call.id}.json`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to pin evidence for call ${call.id}: ${(err as Error).message}`,
        );
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    let oracleSignature: string | undefined;
    try {
      if (call.chain === 'stellar') {
        oracleSignature = this.signEd25519(
          call.id,
          outcome,
          price,
          timestamp,
        ).signatureHex;
      } else {
        // Pass the scaled price as a string (not Number()) — 1e18-scaled
        // uint256 values routinely exceed Number.isSafeInteger, and ethers'
        // typed-data encoder rejects lossy numeric conversions.
        oracleSignature = await this.signEIP712(
          call.id,
          outcome,
          scaledPrice,
          timestamp,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to sign outcome for call ${call.id}: ${(err as Error).message}`,
      );
    }

    call.status = 'SETTLED';
    call.outcome = outcome;
    call.finalPrice = price;
    // BE-019: the 24 h dispute window is measured from settlement, so this has
    // to be stamped here. `settledAt` is set once and never moved, unlike
    // `updatedAt`, so a later edit cannot silently move a dispute deadline.
    call.settledAt = new Date();
    call.evidenceCid = evidenceCid ?? call.evidenceCid;
    call.oracleSignature = oracleSignature ?? call.oracleSignature;
    await manager.save(Call, call);

    if (this.auditLogRepository) {
      await manager.save(AuditLog, {
        action: AuditLogAction.ORACLE_SETTLEMENT,
        actor: 'oracle-worker',
        targetResource: `call:${call.id}`,
        payload: { outcome, price, scaledPrice, source },
        evidenceCid,
        chain: call.chain,
      });
    }

    this.eventEmitter?.emit('oracle.settlement', {
      callId: call.id,
      chain: call.chain,
      outcome,
      finalPrice: price,
      scaledPrice,
      evidenceCid,
      oracleSignature,
      source,
    });

    return {
      callId: call.id,
      status: 'SETTLED',
      outcome,
      finalPrice: price,
      evidenceCid,
      oracleSignature,
    };
  }

  /**
   * Determines the boolean outcome for a call given the resolved price.
   * Reads `{ direction: 'above' | 'below', targetPrice: number }` from
   * `conditionJson` — the shape populated by the indexer from the call's
   * pinned IPFS metadata. Defaults to `false` if the condition is missing
   * or malformed, since an ambiguous condition should never resolve to a
   * false-positive "yes".
   */
  private determineOutcome(call: Call, price: number): boolean {
    const condition = call.conditionJson as
      | { direction?: 'above' | 'below'; targetPrice?: number }
      | undefined;

    if (!condition?.direction || typeof condition.targetPrice !== 'number') {
      this.logger.warn(
        `Call ${call.id} has no usable conditionJson — defaulting outcome to false`,
      );
      return false;
    }

    return condition.direction === 'above'
      ? price >= condition.targetPrice
      : price <= condition.targetPrice;
  }

  /**
   * Freeze a call whose price cannot be trusted (BE-018).
   *
   * The call is left with no outcome, no final price, and no signature. That
   * matters: a halted call must not be readable as "resolved to something",
   * because the only thing anyone can do with a signature is act on it.
   */
  private async haltResolution(
    call: Call,
    violations: StalenessViolation[],
    manager: import('typeorm').EntityManager,
  ): Promise<ResolutionResult> {
    const reason = violations.map((v) => v.message).join('; ');
    this.logger.error(
      `Call ${call.id} frozen as RESOLUTION_HALTED: ${reason}`,
    );

    call.status = 'RESOLUTION_HALTED';
    call.resolutionHaltedReason = reason;
    call.statusUpdatedAt = new Date();
    await manager.save(Call, call);

    if (this.auditLogRepository) {
      await manager.save(AuditLog, {
        action: AuditLogAction.ORACLE_RESOLUTION_HALTED,
        actor: 'oracle-worker',
        targetResource: `call:${call.id}`,
        payload: {
          reason,
          violations,
          tokenAddress: call.tokenAddress,
          endTs: call.endTs,
        },
        chain: call.chain,
      });
    }

    this.eventEmitter?.emit('oracle.resolution_halted', {
      callId: call.id,
      chain: call.chain,
      reason,
      violations,
    });

    await this.notifyAdminOfHalt(call, violations);

    return {
      callId: call.id,
      status: 'RESOLUTION_HALTED',
      haltedReason: reason,
    };
  }

  /**
   * Alert admins that a call was frozen, with the full context needed to
   * decide whether to unfreeze it.
   *
   * A freeze with no alert is worse than no freeze: the call silently stops
   * resolving and nobody investigates.
   */
  private async notifyAdminOfHalt(
    call: Call,
    violations: StalenessViolation[],
  ): Promise<void> {
    const webhookUrl = this.configService.get<string>(
      'DISCORD_ADMIN_WEBHOOK_URL',
    );
    const lines = [
      `🧊 **Resolution Frozen** 🧊`,
      `Call ID: ${call.id} (on-chain ${call.callOnchainId ?? 'n/a'}) was frozen as ` +
        '**RESOLUTION_HALTED** and will not settle on its current price.',
      `Token: \`${call.tokenAddress}\``,
      `Chain: ${call.chain}`,
      `End: ${call.endTs?.toISOString?.() ?? 'unknown'}`,
      '',
      '**Reasons**',
      ...violations.map(
        (v) =>
          `• \`${v.reason}\` — ${v.message}` +
          (v.source ? ` (source: ${v.source})` : ''),
      ),
      '',
      `Thresholds: max age ${violations[0]?.staleThresholdSeconds}s, ` +
        `min 24h volume $${violations[0]?.volumeThreshold}.`,
      '',
      'Resolve by fixing the underlying feed, then unfreeze via the admin API: ' +
        '`POST /admin/calls/:id/unfreeze-resolution`.',
    ];

    const message = lines.join('\n');

    if (!webhookUrl) {
      this.logger.warn(
        `No DISCORD_ADMIN_WEBHOOK_URL configured. Call ${call.id} frozen. ${message}`,
      );
      return;
    }

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });
    } catch (err) {
      // A failed alert must not roll back the freeze: settling on a bad price
      // is the outcome we are trying to prevent, and a webhook outage is not
      // a reason to start settling anyway.
      this.logger.error(
        `Failed to send freeze alert for call ${call.id}: ${(err as Error).message}`,
      );
    }
  }

  private async recordUnresolved(
    call: Call,
    error: Error,
    manager: import('typeorm').EntityManager,
  ): Promise<void> {
    this.logger.error(`Call ${call.id} marked UNRESOLVED: ${error.message}`);

    if (this.auditLogRepository) {
      await manager.save(AuditLog, {
        action: AuditLogAction.ORACLE_UNRESOLVED,
        actor: 'oracle-worker',
        targetResource: `call:${call.id}`,
        payload: { reason: error.message },
        chain: call.chain,
      });
    }

    this.eventEmitter?.emit('oracle.unresolved', {
      callId: call.id,
      chain: call.chain,
      reason: error.message,
    });

    await this.notifyAdmin(call, error);
  }

  /** Sends a best-effort admin alert on total price-feed outage (BE-01). */
  private async notifyAdmin(call: Call, error: Error): Promise<void> {
    const webhookUrl = this.configService.get<string>(
      'DISCORD_ADMIN_WEBHOOK_URL',
    );
    const message =
      `🚨 **Oracle Resolution Failed** 🚨\n` +
      `Call ID: ${call.id} could not be resolved and was marked **UNRESOLVED**.\n` +
      `Reason: ${error.message}`;

    if (!webhookUrl) {
      this.logger.warn(`No DISCORD_ADMIN_WEBHOOK_URL configured. ${message}`);
      return;
    }

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });
    } catch (err) {
      this.logger.error(
        `Failed to send admin notification for call ${call.id}: ${(err as Error).message}`,
      );
    }
  }

  // ─── EVM (EIP-712) signing ────────────────────────────────────────────────

  /**
   * Signs an outcome with EIP-712 through the active key signer (local
   * wallet or KMS — see key-signer.ts). This is the BE-02 entry point;
   * `signOutcome()` below is kept as-is for backward compatibility with
   * existing callers/tests.
   */
  async signEIP712(
    callId: number,
    outcome: boolean,
    finalPrice: number | string | bigint,
    timestamp: number,
  ): Promise<string> {
    if (this.adminService.isPaused()) {
      throw new ServiceUnavailableException(
        'Protocol is paused. Oracle signatures are disabled.',
      );
    }
    if (!this.activeSigner) {
      throw new Error(
        'Oracle signer not configured (no ORACLE_PRIVATE_KEY or KMS_URL)',
      );
    }

    const domain = {
      name: 'OnChainSageOutcome',
      version: '1',
      chainId: this.configService.get<number>('ORACLE_CHAIN_ID', 8453),
      verifyingContract: this.configService.get<string>(
        'OUTCOME_MANAGER_ADDRESS',
      ),
    };

    const types = {
      Outcome: [
        { name: 'callId', type: 'uint256' },
        { name: 'outcome', type: 'bool' },
        { name: 'finalPrice', type: 'uint256' },
        { name: 'timestamp', type: 'uint256' },
      ],
    };

    const value = { callId, outcome, finalPrice, timestamp };

    return this.activeSigner.signTypedData(domain, types, value);
  }

  /**
   * Rotates the active signing key (BE-02). Callers must gate this behind
   * an admin-only, multisig-guarded route (see AdminController + AdminGuard).
   *
   *   - LocalWalletSigner: pass a new 0x-prefixed private key.
   *   - KmsSigner: pass a new key alias/id — the private key itself never
   *     transits through this process.
   */
  async rotateOracleKey(newKeyMaterial: string): Promise<{ address: string }> {
    if (!this.activeSigner) {
      throw new Error('No active signer configured to rotate');
    }

    if (this.activeSigner instanceof LocalWalletSigner) {
      this.activeSigner.rotate(newKeyMaterial);
    } else if (this.activeSigner instanceof KmsSigner) {
      this.activeSigner.rotate(newKeyMaterial);
    }

    const address = await this.activeSigner.getAddress();

    if (this.auditLogRepository) {
      await this.auditLogRepository.save(
        this.auditLogRepository.create({
          action: AuditLogAction.ORACLE_KEY_ROTATED,
          actor: 'admin',
          targetResource: 'oracle-signer',
          payload: { newAddress: address, signerKind: this.activeSigner.kind },
        }),
      );
    }

    this.eventEmitter?.emit('oracle.key.rotated', {
      address,
      signerKind: this.activeSigner.kind,
    });

    return { address };
  }

  async signOutcome(
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
  ): Promise<string> {
    if (this.adminService.isPaused()) {
      throw new ServiceUnavailableException(
        'Protocol is paused. Oracle signatures are disabled.',
      );
    }
    if (!this.signer) throw new Error('Oracle signer not configured');

    const payload = this.outcomeTypedData(
      callId,
      outcome,
      finalPrice,
      timestamp,
    );

    return this.signer.signTypedData(
      payload.domain,
      payload.types,
      payload.value,
    );
  }

  /**
   * The EIP-712 payload a resolution outcome is signed over.
   *
   * One builder for both signing paths: the single-signer `signOutcome` and the
   * M-of-N round in `signOutcomeWithQuorum` have to agree on exactly the bytes
   * they ask the node set to sign, or a vote would verify against a different
   * payload than the one this node submits.
   */
  private outcomeTypedData(
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
  ): ResolutionPayload {
    return {
      domain: {
        name: 'OnChainSageOutcome',
        version: '1',
        chainId: 84532, // Base Sepolia
        verifyingContract: this.configService.get<string>(
          'OUTCOME_MANAGER_ADDRESS',
        ),
      },
      types: {
        Outcome: [
          { name: 'callId', type: 'uint256' },
          { name: 'outcome', type: 'bool' },
          { name: 'finalPrice', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
        ],
      },
      value: { callId, outcome, finalPrice, timestamp },
    };
  }

  /**
   * BE-017: agree an outcome with the peer oracle nodes before signing it.
   *
   * The round asks every registered node to sign the same EIP-712 payload this
   * node is about to sign; once M verified, distinct votes are in, the outcome
   * is signed here and returned together with the aggregated signature set the
   * contract submission needs. When the nodes do not reach the threshold the
   * call is **not** signed — a resolution that only this node agreed to is
   * worse than a resolution that waits, and the round never throws, so a
   * silent node cannot stall the pipeline (it shows up as `reason: 'timeout'`).
   */
  async signOutcomeWithQuorum(
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
    overrides: { timeoutMs?: number; threshold?: number } = {},
  ): Promise<QuorumOutcomeResult> {
    const payload = this.outcomeTypedData(
      callId,
      outcome,
      finalPrice,
      timestamp,
    );

    if (!this.quorum) {
      this.logger.warn(
        `call ${callId}: quorum consensus is not wired, refusing to sign an unagreed outcome`,
      );
      return { converged: false, reason: 'no-quorum-service' };
    }

    const result = await this.quorum.resolve(payload, overrides);
    if (!result.converged) {
      this.logger.warn(
        `call ${callId}: no quorum after ${result.latencyMs}ms (${result.signers.length}/${result.threshold} verified votes, reason: ${result.reason ?? 'unknown'})`,
      );
      return {
        converged: false,
        reason: result.reason ?? 'unknown',
        latencyMs: result.latencyMs,
        signers: result.signers,
        rejections: result.rejections,
      };
    }

    const signature = await this.signOutcome(
      callId,
      outcome,
      finalPrice,
      timestamp,
    );

    this.logger.log(
      `call ${callId}: quorum reached in ${result.latencyMs}ms (${result.signers.length}/${result.threshold} nodes, payload ${result.payloadHash})`,
    );

    return {
      converged: true,
      signature,
      aggregate: result.aggregate,
      signers: result.signers,
      signatures: result.signatures,
      payloadHash: result.payloadHash,
      threshold: result.threshold,
      nodeCount: result.nodeCount,
      latencyMs: result.latencyMs,
    };
  }

  // ─── Stellar (ed25519) signing ────────────────────────────────────────────

  /**
   * BE-012: the canonical resolution payload the Soroban `OutcomeManager`
   * contract verifies. Exposed on the service so the relayer (BE-14) and the
   * tests agree on one byte layout.
   */
  buildResolutionPayload(
    callId: number,
    outcomeIndex: 0 | 1 | boolean,
    finalPrice: number | string | bigint,
    timestamp: number,
  ): StellarResolutionPayload {
    const payload: StellarResolutionPayload = {
      callId,
      outcomeIndex,
      finalPrice,
      timestamp,
    };
    // Fail fast at the call site as well as inside the signer: an invalid
    // payload must never reach a signing operation, HSM or local alike.
    assertValidResolutionPayload(payload);
    return payload;
  }

  /** The exact 33 bytes the contract rebuilds before `ed25519_verify`. */
  buildCanonicalPayload(payload: StellarResolutionPayload): Buffer {
    return buildCanonicalResolutionPayload(payload);
  }

  /** sha256 of the canonical payload — the audit-log / idempotency key. */
  digestResolution(payload: StellarResolutionPayload): string {
    return digestResolutionPayload(payload);
  }

  /**
   * BE-012: signs a Soroban resolution vote.
   *
   * Signs the canonical 33-byte payload (not a human-readable string), so the
   * 64-byte signature is directly consumable by
   * `env.crypto().ed25519_verify(&oracle_pubkey, &message, &signature)` inside
   * `submit_outcome`.
   */
  async signResolution(
    payload: StellarResolutionPayload,
  ): Promise<StellarSignature> {
    if (this.adminService.isPaused()) {
      throw new ServiceUnavailableException(
        'Protocol is paused. Oracle signatures are disabled.',
      );
    }
    if (!this.activeStellarSigner) {
      throw new Error(
        'Stellar oracle signer not configured (no STELLAR_ORACLE_SECRET_KEY or STELLAR_KMS_URL)',
      );
    }

    const signature = await this.activeStellarSigner.sign(payload);
    this.logger.log(
      `Signed resolution payload ${signature.payloadHash} for call ${payload.callId} ` +
        `(outcome ${payload.outcomeIndex === true ? 1 : payload.outcomeIndex === false ? 0 : payload.outcomeIndex}, ${this.activeStellarSigner.kind} key)`,
    );
    return signature;
  }

  /** Convenience wrapper: build the payload, then sign it. */
  async signResolutionForCall(
    callId: number,
    outcome: boolean,
    finalPrice: number | string | bigint,
    timestamp: number,
  ): Promise<StellarSignature> {
    return this.signResolution(
      this.buildResolutionPayload(callId, outcome, finalPrice, timestamp),
    );
  }

  /**
   * Sign outcome with ed25519 for Stellar/Soroban verification.
   *
   * Message format: BackIt:Outcome:{callId}:{outcome}:{finalPrice}:{timestamp}
   *   - callId:     unique identifier for the call
   *   - outcome:    'true' or 'false' (as string)
   *   - finalPrice: the final price as a number
   *   - timestamp:  unix timestamp in seconds
   *
   * @deprecated Legacy ASCII framing kept for callers that verify off-chain
   * with the `verifyEd25519` helper. On-chain submissions must use
   * `signResolution`, which signs the canonical payload the contract rebuilds.
   *
   * @returns 64-byte Buffer (compatible with Soroban BytesN<64>)
   */
  signStellarOutcome(
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
  ): Buffer {
    if (this.adminService.isPaused()) {
      throw new ServiceUnavailableException(
        'Protocol is paused. Oracle signatures are disabled.',
      );
    }
    if (!this.stellarKeypair) {
      throw new Error('Stellar keypair not configured');
    }

    // Must match exactly what the Soroban contract expects
    const message = `BackIt:Outcome:${callId}:${outcome}:${finalPrice}:${timestamp}`;
    const messageBuffer = Buffer.from(message, 'utf-8');

    return this.stellarKeypair.sign(messageBuffer);
  }

  // ─── Stellar (tweetnacl ed25519) signing — BE-03 ──────────────────────────

  /**
   * Builds the canonical outcome message signed for Stellar/Soroban
   * verification: `BackIt:Outcome:{callId}:{0|1}:{finalPrice}:{timestamp}`.
   *
   * Outcome is encoded as `0`/`1` (not `true`/`false`) to match the exact
   * byte layout the Soroban `outcome_manager` contract reconstructs and
   * verifies on-chain.
   */
  buildStellarMessage(
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
  ): string {
    return `BackIt:Outcome:${callId}:${outcome ? 1 : 0}:${finalPrice}:${timestamp}`;
  }

  /**
   * Signs a Stellar outcome using `tweetnacl.sign.detached` directly (BE-03),
   * rather than going through the Stellar SDK's `Keypair.sign` wrapper.
   * Returns hex-encoded signature (BytesN<64>) and public key (BytesN<32>)
   * ready to hand to the Soroban contract call.
   */
  signEd25519(
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
  ): { signatureHex: string; publicKeyHex: string; message: string } {
    if (this.adminService.isPaused()) {
      throw new ServiceUnavailableException(
        'Protocol is paused. Oracle signatures are disabled.',
      );
    }
    if (!this.stellarKeypair) {
      throw new Error('Stellar keypair not configured');
    }

    const message = this.buildStellarMessage(
      callId,
      outcome,
      finalPrice,
      timestamp,
    );
    const messageBytes = Buffer.from(message, 'utf-8');

    // rawSecretKey() returns the 32-byte ed25519 seed; tweetnacl derives the
    // full 64-byte secret key (seed + public key) from it.
    const seed = this.stellarKeypair.rawSecretKey();
    const naclKeyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));

    const signature = nacl.sign.detached(
      new Uint8Array(messageBytes),
      naclKeyPair.secretKey,
    );

    return {
      signatureHex: Buffer.from(signature).toString('hex'),
      publicKeyHex: Buffer.from(naclKeyPair.publicKey).toString('hex'),
      message,
    };
  }

  /** Verifies a signature produced by signEd25519() — used in tests and admin tooling. */
  verifyEd25519(
    message: string,
    signatureHex: string,
    publicKeyHex: string,
  ): boolean {
    return nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(message, 'utf-8')),
      new Uint8Array(Buffer.from(signatureHex, 'hex')),
      new Uint8Array(Buffer.from(publicKeyHex, 'hex')),
    );
  }

  /**
   * Sign outcome based on chain type.
   * Automatically selects EIP-712 (EVM/Base) or ed25519 (Stellar) signing.
   *
   * @param chain       - 'base' or 'stellar'
   * @param callId      - unique call identifier
   * @param outcome     - whether the outcome was successful
   * @param finalPrice  - final price value
   * @param timestamp   - unix timestamp when the outcome was determined
   * @returns hex string (EVM) or base64 string (Stellar)
   */
  async signOutcomeForChain(
    chain: 'base' | 'stellar',
    callId: number,
    outcome: boolean,
    finalPrice: number,
    timestamp: number,
  ): Promise<string> {
    if (chain === 'stellar') {
      const signature = this.signStellarOutcome(
        callId,
        outcome,
        finalPrice,
        timestamp,
      );
      return signature.toString('base64');
    }

    return this.signOutcome(callId, outcome, finalPrice, timestamp);
  }

  async getAggregatedPrice(symbol: string): Promise<AggregatedPrice | null> {
    const key = symbol.trim().toUpperCase();
    if (!key) return null;

    const cached = await this.readAggregatedCache(key);
    if (cached) return cached;

    const settled = await Promise.allSettled(
      this.priceProviders.map((provider) => provider.fetchQuote(key)),
    );

    const quotes: PriceQuote[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value !== null) {
        quotes.push(result.value);
      }
    }

    const fresh = quotes.filter(
      (quote) => Date.now() - quote.timestamp <= OracleService.MAX_QUOTE_AGE_MS,
    );

    if (fresh.length === 0) {
      return null;
    }

    const filtered = this.rejectOutliers(fresh);
    if (filtered.length === 0) {
      return null;
    }

    const price = this.volumeWeightedMedian(filtered);
    if (price === null) {
      return null;
    }

    const aggregated: AggregatedPrice = {
      symbol: key,
      price,
      sources: filtered.map((quote) => quote.source),
      timestamp: Date.now(),
      confidence: confidenceForProviderCount(filtered.length),
    };

    await this.writeAggregatedCache(key, aggregated);
    return aggregated;
  }

  private rejectOutliers(quotes: PriceQuote[]): PriceQuote[] {
    if (quotes.length < 3) {
      return quotes;
    }

    const prices = quotes.map((quote) => quote.price).sort((a, b) => a - b);
    const mid = prices.length >> 1;
    const median =
      prices.length % 2 === 1
        ? prices[mid]
        : (prices[mid - 1] + prices[mid]) / 2;

    return quotes.filter(
      (quote) =>
        Math.abs(quote.price - median) / median <=
        OracleService.OUTLIER_DEVIATION,
    );
  }

  private volumeWeightedMedian(quotes: PriceQuote[]): number | null {
    if (quotes.length === 0) return null;

    const usable = quotes.filter(
      (quote) => Number.isFinite(quote.price) && quote.price > 0,
    );
    if (usable.length === 0) return null;

    const totalVolume = usable.reduce(
      (acc, quote) => acc + Math.max(0, quote.volume24h),
      0,
    );

    if (totalVolume <= 0) {
      return this.simpleMedian(usable.map((quote) => quote.price));
    }

    const sorted = [...usable].sort((a, b) => a.price - b.price);
    const half = totalVolume / 2;
    let cumulative = 0;

    for (const quote of sorted) {
      cumulative += Math.max(0, quote.volume24h);
      if (cumulative >= half) {
        return quote.price;
      }
    }

    return sorted[sorted.length - 1].price;
  }

  private simpleMedian(prices: number[]): number {
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private async readAggregatedCache(
    key: string,
  ): Promise<AggregatedPrice | null> {
    const prefixed = `${OracleService.PRICE_CACHE_PREFIX}${key}`;

    const memoryEntry = this.inMemoryPriceCache.get(prefixed);
    if (memoryEntry) {
      if (memoryEntry.expiresAt > Date.now()) {
        return memoryEntry.value;
      }
      this.inMemoryPriceCache.delete(prefixed);
    }

    if (!this.redisClient) {
      return null;
    }

    try {
      const raw = await this.redisClient.get(prefixed);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as AggregatedPrice;
      this.inMemoryPriceCache.set(prefixed, {
        value: parsed,
        expiresAt: Date.now() + OracleService.PRICE_CACHE_TTL_MS,
      });
      return parsed;
    } catch (err) {
      this.logger.warn(
        `Price cache read failed for ${key}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async writeAggregatedCache(
    key: string,
    value: AggregatedPrice,
  ): Promise<void> {
    const prefixed = `${OracleService.PRICE_CACHE_PREFIX}${key}`;
    const expiresAt = Date.now() + OracleService.PRICE_CACHE_TTL_MS;

    this.inMemoryPriceCache.set(prefixed, { value, expiresAt });

    if (!this.redisClient) {
      return;
    }

    try {
      await this.redisClient.set(
        prefixed,
        JSON.stringify(value),
        'NX',
        'PX',
        OracleService.PRICE_CACHE_TTL_MS,
      );
    } catch (err) {
      this.logger.warn(
        `Price cache write failed for ${key}: ${(err as Error).message}`,
      );
    }
  }
}
