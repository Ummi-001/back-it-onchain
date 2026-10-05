/**
 * stellar-relayer.service.ts  (BE-014)
 *
 * Submits signed `submit_outcome` transactions to the Stellar/Soroban
 * OutcomeManager the moment a call reaches its `endTs`.
 *
 * What this has to get right
 * ──────────────────────────
 *  - **On time.** The whole point is the 30 s SLA: jobs are scheduled off
 *    `endTs` rather than polled on a coarse interval.
 *  - **Once.** A resolution is a state transition with real value attached. A
 *    retried job, a double cron tick, or two API nodes must never produce two
 *    submissions, so every attempt is guarded by a payload-derived id.
 *  - **Serially per account.** A Stellar account has exactly one sequence
 *    number. Two concurrent submissions that both read `seq = 100` produce one
 *    `txBAD_SEQ` at best, and at worst a batch that lands out of order. A
 *    Redis mutex serialises the read-send window across replicas.
 *  - **Recoverable from sequence drift.** The mutex cannot stop another
 *    process (a manual key payment, a second deployment, a tx that landed
 *    while we were down) from moving the sequence number. `txBAD_SEQ` is
 *    therefore an expected, *recoverable* condition, not a failure: re-read the
 *    account and retry rather than parking the resolution.
 *  - **Honest about fees.** A congested network silently drops transactions
 *    that were signed with the base fee, and the job then looks "submitted"
 *    while the ledger never saw it. The fee tracks the observed surge ratio.
 *
 * The Stellar network interaction is behind the `SorobanRelayerTransport`
 * interface so the retry/sequence/fee logic — the part with the real bugs in
 * it — is testable without a node.
 */

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClientProvider } from '../config/redis.config';
import { PaymasterPolicyService } from './paymaster-policy.service';
import { StellarSdkRelayerTransport } from './stellar-relayer.transport';
import {
  ResolutionJob,
  ResolutionJobQueue,
  ResolutionJobProcessor,
  createRelayerQueue,
  newLockToken,
} from './relayer-queue';
import { buildCanonicalResolutionPayload } from './key-signer';

/** Result of a submission attempt. */
export interface RelayerSubmissionResult {
  callId: number;
  callOnchainId: string;
  success: boolean;
  /** Set once a transaction hash exists, even if later confirmation failed. */
  txHash?: string;
  /** How many on-chain attempts were needed. */
  attempts: number;
  /** Present when `success` is false. */
  error?: string;
  /** True when the job was skipped because it was already submitted. */
  duplicate?: boolean;
}

/** Account snapshot needed to build a transaction. */
export interface RelayerAccountSnapshot {
  publicKey: string;
  sequence: string;
  /** Native balance in stroops, as a decimal string. */
  balanceStroops: string;
}

/** Everything the relayer needs to submit one resolution. */
export interface ResolutionSubmission {
  callId: number;
  callOnchainId: string;
  outcome: boolean;
  finalPrice: number;
  /** Unix seconds. */
  timestamp: number;
  /** Raw 32-byte oracle public key. */
  oraclePublicKey: Uint8Array;
  /** Raw 64-byte Ed25519 signature over the canonical payload. */
  signature: Uint8Array;
}

/**
 * Network seam. Implemented by `StellarSdkRelayerTransport` in production and
 * by a fake in tests.
 */
export interface SorobanRelayerTransport {
  /** Current sequence number and balance of the relayer account. */
  loadAccount(): Promise<RelayerAccountSnapshot>;
  /**
   * Minimum fee per unit that the network will currently accept, in
   * stroops. Implementations read this from `getLedger()`.
   */
  fetchMinFee(): Promise<number>;
  /**
   * Simulate, sign and send. Must throw a `SequenceMismatchError` when the
   * network reports `txBAD_SEQ`.
   */
  sendOutcome(input: {
    contractId: string;
    account: RelayerAccountSnapshot;
    submission: ResolutionSubmission;
    /** Fee per unit in stroops, already surge-adjusted by the relayer. */
    feeStroops: number;
  }): Promise<{ txHash: string; surgeRatio: number }>;
  /** Poll until the transaction reaches a terminal state. */
  awaitConfirmation(
    txHash: string,
  ): Promise<{ success: boolean; error?: string }>;
}

/** Signals a recoverable sequence-number conflict. */
export class SequenceMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `relayer account sequence mismatch: expected ${expected}, chain has ${actual}`,
    );
    this.name = 'SequenceMismatchError';
  }
}

/** Injected token so tests can supply their own queue. */
export const RELAYER_QUEUE = 'RELAYER_QUEUE';
/** Injected token so tests can supply their own transport. */
export const RELAYER_TRANSPORT = 'RELAYER_TRANSPORT';

const SEQUENCE_LOCK_KEY = 'oracle:relayer:sequence-lock';
const SEQUENCE_LOCK_TTL_MS = 15_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 20_000;
const LOCK_POLL_MS = 150;

const XLM_STROOPS = 10_000_000;
/** Alert threshold: below this the relayer cannot fund its own submissions. */
const MIN_BALANCE_XLM = 20;
const MIN_BALANCE_STROOPS = MIN_BALANCE_XLM * XLM_STROOPS;

@Injectable()
export class StellarRelayerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarRelayerService.name);

  private queue: ResolutionJobQueue | null = null;
  private transport: SorobanRelayerTransport | null = null;
  private readonly injectedQueue: ResolutionJobQueue | null;
  private readonly injectedTransport: SorobanRelayerTransport | null;
  private readonly processor: ResolutionJobProcessor = async (job) => {
    // The queue's processor signature is Promise<void>; the result is consumed
    // by processJob's own logging and the policy service.
    await this.processJob(job);
  };

  /** Payload-digest → successful submission. The idempotency guard. */
  private readonly submitted = new Map<string, RelayerSubmissionResult>();

  /** Exponential backoff per payload, so a hard failure stops hammering. */
  private readonly failures = new Map<string, number>();

  private contractId: string | null = null;
  private minFeeStroops: number;
  private maxFeeMultiplier: number;
  private maxSequenceRetries: number;
  private slaMs: number;
  private balanceAlerted = false;
  /** Last network minimum observed, for error messages. */
  private networkMinFee = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisClientProvider: RedisClientProvider,
    private readonly paymasterPolicy: PaymasterPolicyService,
    @Optional()
    @Inject(RELAYER_QUEUE)
    queue?: ResolutionJobQueue | null,
    @Optional()
    @Inject(RELAYER_TRANSPORT)
    transport?: SorobanRelayerTransport | null,
  ) {
    this.injectedQueue = queue ?? null;
    this.injectedTransport = transport ?? null;
    this.minFeeStroops = Number(
      this.configService.get<number>('STELLAR_BASE_FEE_STROOPS', 100),
    );
    this.maxFeeMultiplier = Number(
      this.configService.get<number>('STELLAR_MAX_FEE_MULTIPLIER', 10),
    );
    this.maxSequenceRetries = Number(
      this.configService.get<number>('STELLAR_MAX_SEQ_RETRIES', 3),
    );
    this.slaMs = Number(
      this.configService.get<number>('RELAYER_SUBMISSION_SLA_MS', 30_000),
    );
  }

  /**
   * Highest fee the relayer will bid, derived from the configured baseline.
   *
   * A hard ceiling rather than a target: crossing it means the network is in an
   * abnormal state, and settling a single call is not worth draining the
   * account that funds every future resolution.
   */
  private get feeCeilingStroops(): number {
    return this.minFeeStroops * this.maxFeeMultiplier;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.contractId =
      this.configService.get<string>('STELLAR_OUTCOME_MANAGER_CONTRACT_ID') ??
      null;
    this.transport = this.injectedTransport ?? this.buildDefaultTransport();
    this.queue = this.injectedQueue ?? createRelayerQueue();
    this.queue.setProcessor(this.processor);
    this.logger.log(
      `Stellar relayer ready — contract=${this.contractId ?? '(unset)'} ` +
        `SLA=${this.slaMs}ms maxSeqRetries=${this.maxSequenceRetries}`,
    );
    await this.checkRelayerBalance();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  private buildDefaultTransport(): SorobanRelayerTransport | null {
    if (!this.contractId) {
      this.logger.warn(
        'Stellar relayer has no transport: set STELLAR_OUTCOME_MANAGER_CONTRACT_ID ' +
          'and STELLAR_ORACLE_SECRET_KEY to enable on-chain submission',
      );
      return null;
    }
    // A static import: the SDK is already loaded process-wide by the indexer
    // relayer, so deferring it buys nothing and costs type safety.
    try {
      return new StellarSdkRelayerTransport(this.configService);
    } catch (err) {
      // A missing secret is a configuration problem, not a crash: the oracle
      // keeps resolving prices and simply stops submitting on-chain.
      this.logger.error(
        `Stellar relayer transport unavailable: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ─── Scheduling ───────────────────────────────────────────────────────────

  /**
   * Schedule a resolution for the moment the call's window closes.
   *
   * A call already in the past is due immediately — the delay is clamped, not
   * dropped, so a restart that re-enqueues overdue calls still submits them
   * rather than silently skipping them.
   */
  async scheduleResolution(input: {
    callId: number;
    callOnchainId: string;
    endTs: number;
  }): Promise<void> {
    if (!this.queue) {
      this.logger.warn(
        `Cannot schedule call ${input.callId}: relayer queue not initialised`,
      );
      return;
    }
    const delayMs = Math.max(0, input.endTs - Date.now());
    await this.queue.schedule(
      {
        callId: input.callId,
        callOnchainId: input.callOnchainId,
        endTs: input.endTs,
        scheduledAt: Date.now(),
      },
      delayMs,
    );
  }

  async cancelResolution(callId: number): Promise<void> {
    await this.queue?.cancel(callId);
  }

  // ─── Job execution ────────────────────────────────────────────────────────

  /**
   * Build the submission, guard against duplicates, and push it on-chain.
   *
   * The caller (OracleService) supplies the freshly signed outcome, so the
   * signature always matches the payload this method assembles.
   */
  private async processJob(
    job: ResolutionJob,
  ): Promise<RelayerSubmissionResult> {
    const startedAt = Date.now();
    const key = this.dedupeKey(job.callOnchainId);

    const prior = this.submitted.get(key);
    if (prior?.success) {
      this.logger.log(
        `Call ${job.callId} already submitted (${prior.txHash}) — skipping`,
      );
      return { ...prior, duplicate: true };
    }

    const signed = this.configService.get<ResolutionSubmission | null>(
      `oracle:resolution:${job.callId}`,
    );
    if (!signed) {
      // The signer could not produce a usable signature. Retrying the same
      // input will not help, so surface it rather than spinning.
      return {
        callId: job.callId,
        callOnchainId: job.callOnchainId,
        success: false,
        attempts: 0,
        error: 'no signed resolution available for this call',
      };
    }

    if (!this.transport) {
      return {
        callId: job.callId,
        callOnchainId: job.callOnchainId,
        success: false,
        attempts: 0,
        error: 'relayer transport not configured',
      };
    }

    this.failures.delete(key);
    const result = await this.submitWithSequenceRecovery(signed);

    if (result.success) {
      this.submitted.set(key, result);
      await this.paymasterPolicy.recordRelayerFee(
        job.callOnchainId,
        result.txHash ?? 'unknown',
      );
    } else {
      const attempts = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, attempts);
    }

    const elapsed = Date.now() - startedAt;
    if (result.success && elapsed > this.slaMs) {
      this.logger.warn(
        `Call ${job.callId} submitted in ${elapsed}ms — over the ${this.slaMs}ms SLA`,
      );
    }
    return result;
  }

  /**
   * Submit under the sequence mutex, recovering from `txBAD_SEQ` by
   * re-reading the account.
   */
  private async submitWithSequenceRecovery(
    submission: ResolutionSubmission,
  ): Promise<RelayerSubmissionResult> {
    const base: Omit<RelayerSubmissionResult, 'success' | 'attempts'> = {
      callId: submission.callId,
      callOnchainId: submission.callOnchainId,
    };

    let sequenceAttempts = 0;
    // The retry loop is bounded by sequenceRetries; a wrong-contract or
    // wrong-signature rejection re-sends forever otherwise.
    for (;;) {
      const release = await this.acquireSequenceLock(submission.callOnchainId);
      if (!release) {
        return {
          ...base,
          success: false,
          attempts: sequenceAttempts,
          error: 'timed out waiting for the relayer sequence lock',
        };
      }

      try {
        const account = await this.transport!.loadAccount();

        if (BigInt(account.balanceStroops) < BigInt(MIN_BALANCE_STROOPS)) {
          await this.raiseBalanceAlert(account);
          return {
            ...base,
            success: false,
            attempts: sequenceAttempts,
            error:
              `relayer balance ${this.toXlm(account.balanceStroops)} XLM is ` +
              `below the ${MIN_BALANCE_XLM} XLM minimum`,
          };
        }

        const { feeStroops, surgeRatio } = await this.resolveFee();
        if (feeStroops === null) {
          return {
            ...base,
            success: false,
            attempts: sequenceAttempts,
            error:
              `network fee ${this.networkMinFee} stroops/unit exceeds the ` +
              `relayer ceiling of ${this.feeCeilingStroops}; refusing to ` +
              'overpay',
          };
        }

        const sent = await this.transport!.sendOutcome({
          contractId: this.contractId!,
          account,
          submission,
          feeStroops,
        });

        const confirmed = await this.transport!.awaitConfirmation(sent.txHash);
        const attempts = sequenceAttempts + 1;
        if (!confirmed.success) {
          return {
            ...base,
            txHash: sent.txHash,
            success: false,
            attempts,
            error: confirmed.error ?? 'transaction failed on chain',
          };
        }

        this.logger.log(
          `Resolved call ${submission.callId} on-chain: ${sent.txHash} ` +
            `(fee=${feeStroops} stroops/unit, surge=${surgeRatio.toFixed(2)}x, ` +
            `attempts=${attempts})`,
        );
        return { ...base, success: true, txHash: sent.txHash, attempts };
      } catch (err) {
        if (err instanceof SequenceMismatchError) {
          sequenceAttempts++;
          if (sequenceAttempts > this.maxSequenceRetries) {
            return {
              ...base,
              success: false,
              attempts: sequenceAttempts,
              error: `sequence mismatch persisted after ${this.maxSequenceRetries} retries`,
            };
          }
          this.logger.warn(
            `Sequence mismatch for call ${submission.callId} ` +
              `(attempt ${sequenceAttempts}/${this.maxSequenceRetries}) — ` +
              're-reading the relayer account and retrying',
          );
          continue;
        }
        return {
          ...base,
          success: false,
          attempts: sequenceAttempts,
          error: (err as Error).message,
        };
      } finally {
        await release();
      }
    }
  }

  /**
   * Decide the fee to bid.
   *
   * The network's published minimum *is* the price of inclusion — it already
   * rises under congestion, so scaling it again by the surge ratio would pay
   * surge² for no extra chance of landing. The bid is therefore exactly the
   * minimum, with one exception: when that minimum exceeds a ceiling derived
   * from the configured baseline, the relayer refuses rather than drains its
   * own account to settle one call. A fee spike is an incident to be alerted
   * on, not something to silently bid through.
   *
   * Returns `null` for the fee when the ceiling is breached.
   */
  private async resolveFee(): Promise<{
    feeStroops: number | null;
    surgeRatio: number;
  }> {
    const networkMin = await this.transport!.fetchMinFee();
    this.networkMinFee = networkMin;
    const surgeRatio =
      this.minFeeStroops > 0 ? networkMin / this.minFeeStroops : 1;

    if (networkMin > this.feeCeilingStroops) {
      this.logger.error(
        `Network fee ${networkMin} stroops/unit (${surgeRatio.toFixed(1)}x ` +
          `baseline) exceeds the relayer ceiling ${this.feeCeilingStroops} — ` +
          'refusing to submit',
      );
      return { feeStroops: null, surgeRatio };
    }
    return { feeStroops: Math.ceil(networkMin), surgeRatio };
  }

  // ─── Sequence mutex ───────────────────────────────────────────────────────

  /**
   * Acquire the cross-replica sequence lock.
   *
   * Returns a release function, or `null` if the lock could not be taken
   * within the timeout. The lock is a single global key rather than a
   * per-account key because the relayer uses one account for every call.
   */
  private async acquireSequenceLock(
    callOnchainId: string,
  ): Promise<(() => Promise<void>) | null> {
    const client = this.redisClientProvider.getClient();
    const token = newLockToken();
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

    for (;;) {
      try {
        const got = await client.set(
          SEQUENCE_LOCK_KEY,
          token,
          'NX',
          'PX',
          SEQUENCE_LOCK_TTL_MS,
        );
        if (got === 'OK') {
          this.logger.debug(
            `Sequence lock acquired for call ${callOnchainId} (${token.slice(0, 8)})`,
          );
          return async () => {
            try {
              // Token-matched delete: a lock that expired under us must not
              // be deleted out from under the instance that holds it now.
              await client.eval(
                'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
                1,
                SEQUENCE_LOCK_KEY,
                token,
              );
            } catch (err) {
              this.logger.warn(
                `Sequence lock release failed: ${(err as Error).message}`,
              );
            }
          };
        }
      } catch (err) {
        // Redis being down must not stop resolution. Without the mutex we
        // still submit; the sequence retry loop covers the collisions that
        // this allows.
        this.logger.warn(
          `Sequence lock unavailable (${(err as Error).message}) — ` +
            'submitting without mutual exclusion',
        );
        // No lock was taken, so there is nothing to release.
        return () => Promise.resolve();
      }

      if (Date.now() >= deadline) {
        return null;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }

  // ─── Balance monitoring ───────────────────────────────────────────────────

  /**
   * Log and surface a low-balance warning below the 20 XLM floor.
   *
   * Alert-once semantics: a relayer that is short on XLM re-checks its balance
   * on every submission, and warning each time would train operators to ignore
   * the log line.
   */
  private async raiseBalanceAlert(
    account: RelayerAccountSnapshot,
  ): Promise<void> {
    if (this.balanceAlerted) return;
    this.balanceAlerted = true;
    const balanceXlm = this.toXlm(account.balanceStroops);
    this.logger.error(
      `Relayer account ${account.publicKey} holds ${balanceXlm} XLM, ` +
        `below the ${MIN_BALANCE_XLM} XLM minimum. Submissions will be refused ` +
        'until the account is funded.',
    );
    await this.paymasterPolicy.recordRelayerShortfall(
      account.publicKey,
      balanceXlm,
      MIN_BALANCE_XLM,
    );
  }

  /** Fetch the relayer balance and warn if it is low. Never throws. */
  async checkRelayerBalance(): Promise<void> {
    if (!this.transport) return;
    try {
      const account = await this.transport.loadAccount();
      if (BigInt(account.balanceStroops) < BigInt(MIN_BALANCE_STROOPS)) {
        await this.raiseBalanceAlert(account);
      } else if (this.balanceAlerted) {
        this.balanceAlerted = false;
        this.logger.log(
          `Relayer account refunded to ${this.toXlm(account.balanceStroops)} XLM — resuming.`,
        );
      }
    } catch (err) {
      this.logger.warn(`Balance check failed: ${(err as Error).message}`);
    }
  }

  /** Native balance in stroops (decimal string) → XLM as a number. */
  private toXlm(stroops: string): number {
    return Number(stroops) / XLM_STROOPS;
  }
  // ─── Guards and helpers ───────────────────────────────────────────────────

  /**
   * Idempotency key.
   *
   * Keyed on the on-chain id rather than the DB id because that is what the
   * contract uses to reject a duplicate — and it stays stable if the row is
   * re-imported with a different surrogate key.
   */
  private dedupeKey(callOnchainId: string): string {
    return callOnchainId;
  }

  /** Test/health seam: has this call already been submitted? */
  isSubmitted(callOnchainId: string): boolean {
    return this.submitted.get(this.dedupeKey(callOnchainId))?.success === true;
  }

  /** Test seam: the payload the relayer would submit, for assertion. */
  static canonicalPayload(submission: ResolutionSubmission): Uint8Array {
    return buildCanonicalResolutionPayload({
      callId: submission.callId,
      outcomeIndex: submission.outcome,
      finalPrice: submission.finalPrice,
      timestamp: submission.timestamp,
    });
  }
}
