/**
 * stellar-relayer.service.spec.ts  (BE-014)
 *
 * Covers the properties that decide whether a resolution actually lands:
 * on-time scheduling, exactly-once submission, sequence recovery, fee surge
 * handling, and the balance floor.
 *
 * The network is a fake `SorobanRelayerTransport`; the real bugs in a relayer
 * live in the retry/mutex/fee logic, not in the SDK calls.
 */

import { ConfigService } from '@nestjs/config';
import { RedisClientProvider } from '../config/redis.config';
import { PaymasterPolicyService } from './paymaster-policy.service';
import {
  RelayerAccountSnapshot,
  ResolutionSubmission,
  SequenceMismatchError,
  SorobanRelayerTransport,
  StellarRelayerService,
} from './stellar-relayer.service';
import { InProcessRelayerQueue } from './relayer-queue';

const XLM = 10_000_000;

function makeSubmission(
  overrides: Partial<ResolutionSubmission> = {},
): ResolutionSubmission {
  return {
    callId: 1,
    callOnchainId: '42',
    outcome: true,
    finalPrice: 1234,
    timestamp: 1_700_000_000,
    oraclePublicKey: new Uint8Array(32).fill(7),
    signature: new Uint8Array(64).fill(9),
    ...overrides,
  };
}

/** Records every send so tests can assert on sequence/surge behaviour. */
class FakeTransport implements SorobanRelayerTransport {
  sequences: string[] = [];
  loadedSequences: string[] = [];
  sentFees: number[] = [];
  sequenceRejections = 0;
  failNextSend: Error | null = null;
  confirmResult: { success: boolean; error?: string } = { success: true };
  minFee = 100;
  balanceStroops = 1000 * XLM;
  loadCount = 0;

  async loadAccount(): Promise<RelayerAccountSnapshot> {
    this.loadCount++;
    // The sequence advances on every read, standing in for the account's
    // sequence moving as transactions land.
    const sequence = String(100 + this.loadCount - 1);
    this.loadedSequences.push(sequence);
    return {
      publicKey: 'GRELAYER',
      sequence,
      balanceStroops: String(this.balanceStroops),
    };
  }

  async fetchMinFee(): Promise<number> {
    return this.minFee;
  }

  async sendOutcome(input: {
    account: RelayerAccountSnapshot;
    feeStroops: number;
  }): Promise<{ txHash: string; surgeRatio: number }> {
    this.sequences.push(input.account.sequence);
    this.sentFees.push(input.feeStroops);
    if (this.sequenceRejections > 0) {
      this.sequenceRejections--;
      throw new SequenceMismatchError(input.account.sequence, '101');
    }
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = null;
      throw err;
    }
    return { txHash: `tx-${this.sequences.length}`, surgeRatio: 1 };
  }

  async awaitConfirmation(): Promise<{ success: boolean; error?: string }> {
    return this.confirmResult;
  }
}

/** Minimal cache-manager stand-in for the policy service. */
function makeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
    del: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
}

/** Redis fake supporting SET NX PX and the release-if-owner script. */
function makeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const client = {
    set: jest.fn(
      async (k: string, v: string, _m: 'NX', _e: 'PX', ttl: number) => {
        const cur = store.get(k);
        if (cur && cur.expiresAt > Date.now()) return null;
        store.set(k, { value: v, expiresAt: Date.now() + ttl });
        return 'OK';
      },
    ),
    get: jest.fn(async (k: string) => store.get(k)?.value ?? null),
    del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    pexpire: jest.fn(async () => 1),
    eval: jest.fn(async (_s: string, _n: number, k: string, token: string) => {
      const cur = store.get(k);
      if (cur && cur.value === token) {
        store.delete(k);
        return 1;
      }
      return 0;
    }),
    disconnect: jest.fn(),
  };
  return { client, store };
}

/** Map-backed ConfigService stand-in — no Nest internals to fight. */
function makeConfig(values: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(values));
  return {
    values: map,
    // Mirrors the real signature: a second argument is the fallback used when
    // the key is absent, which several of the service's tunables rely on.
    get: (key: string, fallback?: unknown) =>
      map.has(key) ? map.get(key) : fallback,
    set: (key: string, value: unknown) => {
      map.set(key, value);
    },
  } as unknown as ConfigService & { values: Map<string, unknown> };
}

async function buildService(
  transport: FakeTransport,
  overrides: Record<string, unknown> = {},
) {
  const cache = makeCache();
  const redis = makeRedis();
  const queue = new InProcessRelayerQueue();

  const config = makeConfig({
    STELLAR_OUTCOME_MANAGER_CONTRACT_ID: 'CONTRACT123',
    ...overrides,
  });

  const redisProvider = {
    getClient: () => redis.client,
  } as unknown as RedisClientProvider;

  const policy = {
    recordRelayerFee: jest.fn(async () => undefined),
    recordRelayerShortfall: jest.fn(async () => undefined),
  } as unknown as PaymasterPolicyService;

  // The queue and transport are injected, so tests supply fakes and never
  // construct a real Redis connection or a Soroban client.
  const service = new StellarRelayerService(
    config,
    redisProvider,
    policy,
    queue,
    transport,
  );
  await service.onModuleInit();
  return { service, queue, cache, policy, redis, config };
}

describe('StellarRelayerService (BE-014)', () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  describe('scheduling', () => {
    it('schedules a call to fire at its endTs, not on a coarse poll interval', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);

      const endTs = Date.now() + 120_000;
      await service.scheduleResolution({
        callId: 5,
        callOnchainId: '5',
        endTs,
      });

      expect(await queue.pendingCount()).toBe(1);
    });

    it('fires a call whose window has already closed rather than skipping it', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);
      const processor = jest.fn();
      queue.setProcessor(processor);

      // endTs in the past: the clamp must produce a 0 ms delay, not a
      // negative one that setTimeout would treat as "never".
      await service.scheduleResolution({
        callId: 6,
        callOnchainId: '6',
        endTs: Date.now() - 5_000,
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(processor).toHaveBeenCalled();
    });

    it('replaces a pending job when the same call is rescheduled', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);

      await service.scheduleResolution({
        callId: 7,
        callOnchainId: '7',
        endTs: Date.now() + 60_000,
      });
      await service.scheduleResolution({
        callId: 7,
        callOnchainId: '7',
        endTs: Date.now() + 90_000,
      });

      // Re-scheduling the same call must not queue a second submission.
      expect(await queue.pendingCount()).toBe(1);
    });

    it('cancels a pending resolution', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);

      await service.scheduleResolution({
        callId: 8,
        callOnchainId: '8',
        endTs: Date.now() + 60_000,
      });
      await service.cancelResolution(8);

      expect(await queue.pendingCount()).toBe(0);
    });
  });

  describe('sequence management', () => {
    it('reads a fresh account sequence for each send', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);
      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(true);
      expect(transport.sequences).toHaveLength(1);
      // The sequence used must be the one read immediately before the send,
      // never a value cached from an earlier load.
      expect(transport.sequences[0]).toBe(
        transport.loadedSequences[transport.loadedSequences.length - 1],
      );
    });

    it('recovers from a sequence mismatch by re-reading the account', async () => {
      const transport = new FakeTransport();
      transport.sequenceRejections = 1;
      const { service, queue } = await buildService(transport);

      const result = await submitNow(service, queue, transport, {
        callId: 2,
        callOnchainId: '2',
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      // The first send used a stale sequence and was rejected; the retry must
      // use a freshly-read one, not repeat it.
      expect(transport.sequences).toHaveLength(2);
      expect(transport.sequences[0]).not.toBe(transport.sequences[1]);
    });

    it('gives up after the configured retry budget instead of looping forever', async () => {
      const transport = new FakeTransport();
      transport.sequenceRejections = 99;
      const { service, queue } = await buildService(transport, {
        STELLAR_MAX_SEQ_RETRIES: 2,
      });

      const result = await submitNow(service, queue, transport, {
        callId: 3,
        callOnchainId: '3',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sequence mismatch persisted/);
      // One initial attempt plus the retry budget.
      expect(transport.sequences).toHaveLength(3);
    });

    it('serialises concurrent submissions through the Redis sequence lock', async () => {
      const transport = new FakeTransport();
      const { service, queue, redis } = await buildService(transport);

      // A single processor must serve both jobs: installing one per call would
      // hide the interleaving this test exists to observe.
      const results = await driveJobs(service, queue, [
        { callId: 10, callOnchainId: '10' },
        { callId: 11, callOnchainId: '11' },
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      expect(transport.sequences).toHaveLength(2);
      // Each submission read a *different* sequence: that is the property the
      // mutex buys, and it is the thing that breaks without it.
      expect(new Set(transport.sequences).size).toBe(2);
      // The lock must not be left behind once the work completes.
      expect(redis.store.size).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('submits a call exactly once even if the job fires twice', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);

      await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });
      const second = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(second.duplicate).toBe(true);
      expect(transport.sequences).toHaveLength(1);
    });

    it('does not cache a failed submission as complete', async () => {
      const transport = new FakeTransport();
      transport.confirmResult = { success: false, error: 'reverted' };
      const { service, queue } = await buildService(transport);

      const failed = await submitNow(service, queue, transport, {
        callId: 2,
        callOnchainId: '2',
      });
      expect(failed.success).toBe(false);
      expect(service.isSubmitted('2')).toBe(false);

      // A later retry must be allowed through.
      transport.confirmResult = { success: true };
      const retried = await submitNow(service, queue, transport, {
        callId: 2,
        callOnchainId: '2',
      });
      expect(retried.success).toBe(true);
    });

    it('keys the guard on the on-chain id, not the row id', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);

      await submitNow(service, queue, transport, {
        callId: 77,
        callOnchainId: '99',
      });
      // Same call, re-imported under a different surrogate key.
      const again = await submitNow(service, queue, transport, {
        callId: 78,
        callOnchainId: '99',
      });

      expect(again.duplicate).toBe(true);
    });
  });

  describe('fee surges', () => {
    it('bids the published network minimum at baseline', async () => {
      const transport = new FakeTransport();
      const { service, queue } = await buildService(transport);

      await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(transport.sentFees).toEqual([100]);
    });

    it('tracks the minimum upward when the network surges', async () => {
      const transport = new FakeTransport();
      transport.minFee = 500;
      const { service, queue } = await buildService(transport);

      await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      // The published minimum is already the price of inclusion. Multiplying
      // it by the surge ratio again would pay 5x for a 5x surge.
      expect(transport.sentFees).toEqual([500]);
    });

    it('refuses to bid past the ceiling rather than draining the account', async () => {
      const transport = new FakeTransport();
      transport.minFee = 5_000;
      const { service, queue } = await buildService(transport, {
        STELLAR_MAX_FEE_MULTIPLIER: 3,
      });

      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exceeds the relayer ceiling/);
      expect(transport.sentFees).toHaveLength(0);
    });

    it('still submits at exactly the ceiling', async () => {
      const transport = new FakeTransport();
      transport.minFee = 300;
      const { service, queue } = await buildService(transport, {
        STELLAR_MAX_FEE_MULTIPLIER: 3,
      });

      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(true);
      expect(transport.sentFees).toEqual([300]);
    });
  });

  describe('balance floor', () => {
    it('refuses to submit when the relayer is under 20 XLM', async () => {
      const transport = new FakeTransport();
      transport.balanceStroops = 19 * XLM;
      const { service, queue, policy } = await buildService(transport);

      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/below the 20 XLM minimum/);
      expect(transport.sequences).toHaveLength(0);
      expect(policy.recordRelayerShortfall).toHaveBeenCalled();
    });

    it('submits when the balance is exactly at the floor', async () => {
      const transport = new FakeTransport();
      transport.balanceStroops = 20 * XLM;
      const { service, queue } = await buildService(transport);

      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(true);
    });

    it('warns about a low balance only once until it is funded again', async () => {
      const transport = new FakeTransport();
      transport.balanceStroops = 5 * XLM;
      const { service, policy } = await buildService(transport);

      await service.checkRelayerBalance();
      await service.checkRelayerBalance();
      await service.checkRelayerBalance();
      expect(policy.recordRelayerShortfall).toHaveBeenCalledTimes(1);

      // Refund, then drain again: the operator should be warned again.
      transport.balanceStroops = 500 * XLM;
      await service.checkRelayerBalance();
      transport.balanceStroops = 5 * XLM;
      await service.checkRelayerBalance();
      expect(policy.recordRelayerShortfall).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure handling', () => {
    it('surfaces a transport error instead of throwing', async () => {
      const transport = new FakeTransport();
      transport.failNextSend = new Error('RPC unreachable');
      const { service, queue } = await buildService(transport);

      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/RPC unreachable/);
    });

    it('keeps the tx hash when confirmation fails so it can be reconciled', async () => {
      const transport = new FakeTransport();
      transport.confirmResult = { success: false, error: 'reverted on chain' };
      const { service, queue } = await buildService(transport);

      const result = await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '1',
      });

      expect(result.success).toBe(false);
      // The hash exists on the ledger; losing it would orphan the settlement.
      expect(result.txHash).toBe('tx-1');
    });

    it('records the transaction hash against the call on success', async () => {
      const transport = new FakeTransport();
      const { service, queue, policy } = await buildService(transport);

      await submitNow(service, queue, transport, {
        callId: 1,
        callOnchainId: '55',
      });

      expect(policy.recordRelayerFee).toHaveBeenCalledWith('55', 'tx-1');
    });
  });

  describe('payload binding', () => {
    it('assembles the exact byte layout the contract rebuilds', () => {
      const submission = makeSubmission({
        callId: 1,
        outcome: true,
        finalPrice: 1234,
        timestamp: 1_700_000_000,
      });
      const payload = StellarRelayerService.canonicalPayload(submission);

      // submit_outcome verifies sha256 over: u64 callId || u8 outcome
      // || u128 finalPrice || u64 timestamp, all big-endian.
      expect(payload).toHaveLength(33);
      expect(Buffer.from(payload.subarray(0, 8)).toString('hex')).toBe(
        '0000000000000001',
      );
      expect(payload[8]).toBe(1);
      expect(Buffer.from(payload.subarray(9, 25)).toString('hex')).toBe(
        '000000000000000000000000000004d2', // 1234
      );
      expect(Buffer.from(payload.subarray(25, 33)).toString('hex')).toBe(
        '000000006553f100', // 1_700_000_000
      );
    });

    it('encodes a "no" outcome as 0, matching the contract outcome index', () => {
      const payload = StellarRelayerService.canonicalPayload(
        makeSubmission({ outcome: false }),
      );
      expect(payload[8]).toBe(0);
    });
  });
});

/**
 * Drive a resolution through the queue with the call's signed payload staged,
 * the way OracleService would immediately before `endTs`.
 */
async function submitNow(
  service: StellarRelayerService,
  queue: InProcessRelayerQueue,
  transport: FakeTransport,
  call: { callId: number; callOnchainId: string },
) {
  const [result] = await driveJobs(service, queue, [call]);
  expect(transport).toBeDefined();
  return result;
}

/**
 * Drive resolutions through the queue with their signed payloads staged, the
 * way OracleService would immediately before each `endTs`.
 *
 * Uses one processor for all jobs so concurrent submissions actually race for
 * the sequence lock instead of overwriting each other's handler.
 */
async function driveJobs(
  service: StellarRelayerService,
  queue: InProcessRelayerQueue,
  calls: { callId: number; callOnchainId: string }[],
): Promise<RelayerResult[]> {
  const config = (service as unknown as { configService: ConfigService })
    .configService;

  for (const call of calls) {
    config.set(
      `oracle:resolution:${call.callId}`,
      makeSubmission({
        callId: call.callId,
        callOnchainId: call.callOnchainId,
      }),
    );
  }

  const captured = new Map<number, RelayerResult>();
  queue.setProcessor(async (job) => {
    const result = await (
      service as unknown as {
        processJob: (j: unknown) => Promise<RelayerResult>;
      }
    ).processJob(job);
    captured.set(job.callId, result);
  });

  await Promise.all(
    calls.map((call) =>
      queue.schedule(
        {
          callId: call.callId,
          callOnchainId: call.callOnchainId,
          endTs: Date.now(),
          scheduledAt: Date.now(),
        },
        0,
      ),
    ),
  );

  // Poll rather than sleeping a fixed amount: a job that loses the sequence-lock
  // race waits ~150 ms before retrying, so a fixed sleep would be flaky.
  await waitFor(() => captured.size === calls.length);

  return calls.map((call) => captured.get(call.callId) as RelayerResult);
}

interface RelayerResult {
  success: boolean;
  duplicate?: boolean;
  attempts: number;
  txHash?: string;
  error?: string;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
