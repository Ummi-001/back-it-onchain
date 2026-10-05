/**
 * relayer-queue.ts  (BE-014)
 *
 * Delayed-job queue used to schedule Stellar resolution submissions for the
 * moment a call reaches its `endTs`.
 *
 * The queue is an interface rather than a concrete client because the durable
 * option (BullMQ) needs Redis and a running worker, while tests and single-node
 * deployments want zero infrastructure. Two implementations ship here:
 *
 *   - InProcessRelayerQueue  — setTimeout-backed, process-local. The default.
 *   - BullMqRelayerQueue     — `require`s bullmq lazily so deployments that
 *                              never enable it do not need the dependency.
 *
 * A delayed job is only a *trigger*. The relayer re-reads the call's current
 * state before submitting, so a job that fires early, late, or twice is
 * harmless — see the idempotency guard in StellarRelayerService.
 */

import { Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';

/** A single scheduled resolution submission. */
export interface ResolutionJob {
  /** Internal DB id of the call. Used as the dedupe key. */
  callId: number;
  /** On-chain call identifier, as a string (u64-safe). */
  callOnchainId: string;
  /** Unix ms at which the call's resolution window closes. */
  endTs: number;
  /** Unix ms the job was scheduled, for staleness checks. */
  scheduledAt: number;
}

export type ResolutionJobProcessor = (job: ResolutionJob) => Promise<void>;

export interface ResolutionJobQueue {
  /** Install the processor invoked when a job comes due. */
  setProcessor(processor: ResolutionJobProcessor): void;
  /**
   * Schedule `job` to run in `delayMs`. Re-scheduling the same `callId`
   * replaces the pending job rather than adding a second one.
   */
  schedule(job: ResolutionJob, delayMs: number): Promise<void>;
  /** Drop a pending job, e.g. when a call is cancelled or disputed. */
  cancel(callId: number): Promise<void>;
  /** Number of jobs waiting to fire. Exposed for health checks and tests. */
  pendingCount(): Promise<number>;
  close(): Promise<void>;
}

// ─── In-process implementation ───────────────────────────────────────────────

/**
 * setTimeout-backed queue.
 *
 * Note this is *not* durable: pending jobs are lost on restart. Startup
 * recovery is the caller's job — OracleService re-enqueues every unresolved
 * call whose `endTs` has passed, which is what keeps a restart from stranding
 * a resolution.
 */
export class InProcessRelayerQueue implements ResolutionJobQueue {
  private readonly logger = new Logger(InProcessRelayerQueue.name);
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private processor: ResolutionJobProcessor | null = null;
  private closed = false;

  setProcessor(processor: ResolutionJobProcessor): void {
    this.processor = processor;
  }

  schedule(job: ResolutionJob, delayMs: number): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('relayer queue is closed'));
    }
    // Re-scheduling the same call must not queue a second submission.
    const existing = this.timers.get(job.callId);
    if (existing) clearTimeout(existing);
    if (this.timers.size >= this.maxPending()) {
      return Promise.reject(
        new Error(`relayer queue is full (${this.timers.size} pending jobs)`),
      );
    }

    const timer = setTimeout(
      () => {
        this.timers.delete(job.callId);
        void this.run(job);
      },
      Math.max(0, delayMs),
    );
    // Do not hold the event loop open purely for a pending resolution.
    timer.unref?.();
    this.timers.set(job.callId, timer);

    this.logger.debug(
      `Queued call ${job.callId} in ${Math.max(0, delayMs)}ms ` +
        `(${this.timers.size} pending)`,
    );
    return Promise.resolve();
  }

  /**
   * Synchronous implementations satisfying the async interface.
   *
   * `async` is omitted deliberately: these resolve immediately, and the
   * `require-await` rule exists to catch functions where someone forgot to
   * await something. Returning the resolved value directly keeps the class
   * honest while still conforming to `ResolutionJobQueue`.
   */
  cancel(callId: number): Promise<void> {
    const timer = this.timers.get(callId);
    if (!timer) return Promise.resolve();
    clearTimeout(timer);
    this.timers.delete(callId);
    this.logger.debug(`Cancelled queued call ${callId}`);
    return Promise.resolve();
  }

  pendingCount(): Promise<number> {
    return Promise.resolve(this.timers.size);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    return Promise.resolve();
  }

  private async run(job: ResolutionJob): Promise<void> {
    if (!this.processor) {
      this.logger.warn(
        `Dropping job for call ${job.callId} — no processor installed`,
      );
      return;
    }
    try {
      await this.processor(job);
    } catch (err) {
      // A failed job must never take down the scheduler. The relayer already
      // persisted the failure and owns retry policy.
      this.logger.error(
        `Job for call ${job.callId} threw: ${(err as Error).message}`,
      );
    }
  }

  private maxPending(): number {
    return Number(process.env.RELAYER_MAX_PENDING_JOBS ?? 10_000);
  }
}

// ─── BullMQ implementation ───────────────────────────────────────────────────

/**
 * Minimal shape of the BullMQ constructors this adapter uses.
 *
 * bullmq is an optional peer dependency, so its types are not imported; the
 * few members actually called are declared here and validated at load time.
 */
interface BullMqModule {
  Queue: new (name: string, opts: unknown) => BullMqQueue;
  Worker: new (
    name: string,
    processor: (job: { data: ResolutionJob }) => Promise<void>,
    opts: unknown,
  ) => BullMqWorker;
}

interface BullMqQueue {
  upsertJobScheduler?: (
    id: string,
    repeat: { every: number },
    template: { name: string; data: ResolutionJob; opts: { jobId: string } },
  ) => Promise<unknown>;
  add: (name: string, data: ResolutionJob, opts: unknown) => Promise<unknown>;
  getJob: (id: string) => Promise<BullMqJob | null>;
  getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
  close: () => Promise<void>;
}

interface BullMqJob {
  remove: () => Promise<void>;
}

interface BullMqWorker {
  close: () => Promise<void>;
}

/**
 * Load and validate the optional bullmq dependency.
 *
 * A missing or malformed module is a hard error: silently degrading to the
 * non-durable in-process queue would strand resolutions on every restart, so
 * a deployment that asked for bullmq must fail loudly if it is unavailable.
 */
function loadBullMq(): BullMqModule {
  let mod: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('bullmq');
  } catch (err) {
    throw new Error(
      `RELAYER_QUEUE_DRIVER=bullmq but bullmq could not be loaded: ${
        (err as Error).message
      }. Install it, or unset the driver to use the in-process queue.`,
    );
  }
  const candidate = mod as Partial<BullMqModule>;
  if (
    typeof candidate.Queue !== 'function' ||
    typeof candidate.Worker !== 'function'
  ) {
    throw new Error(
      'the installed bullmq module does not export Queue and Worker',
    );
  }
  return candidate as BullMqModule;
}

/**
 * Durable queue backed by BullMQ.
 *
 * Selected when `RELAYER_QUEUE_DRIVER=bullmq`. bullmq is loaded at construction
 * so that installs without it still boot.
 */
export class BullMqRelayerQueue implements ResolutionJobQueue {
  private readonly logger = new Logger(BullMqRelayerQueue.name);
  private readonly queueName: string;
  private readonly connection: Record<string, unknown>;
  private readonly dynamicDelay = Boolean(
    process.env.RELAYER_JOB_DYNAMIC_DELAY,
  );
  private queue: BullMqQueue;
  private worker: BullMqWorker;
  private processor: ResolutionJobProcessor | null = null;
  private closed = false;

  constructor() {
    this.queueName = process.env.RELAYER_QUEUE_NAME ?? 'oracle-resolution';
    // The existing RedisClientProvider owns the connection in-process, so
    // BullMQ gets its own from the same URL.
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('RELAYER_QUEUE_DRIVER=bullmq requires REDIS_URL');
    }
    this.connection = { url, maxRetriesPerRequest: null };
    const { queue, worker } = this.boot(loadBullMq());
    this.queue = queue;
    this.worker = worker;
  }

  private boot(bullMq: BullMqModule): {
    queue: BullMqQueue;
    worker: BullMqWorker;
  } {
    const queue = new bullMq.Queue(this.queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: Number(process.env.RELAYER_JOB_ATTEMPTS ?? 5),
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
    const worker = new bullMq.Worker(
      this.queueName,
      async (job: { data: ResolutionJob }) => this.dispatch(job.data),
      { connection: this.connection },
    );
    this.logger.log(
      `BullMQ relayer queue "${this.queueName}" started ` +
        `(attempts=${process.env.RELAYER_JOB_ATTEMPTS ?? 5})`,
    );
    return { queue, worker };
  }

  setProcessor(processor: ResolutionJobProcessor): void {
    this.processor = processor;
  }

  async schedule(job: ResolutionJob, delayMs: number): Promise<void> {
    if (this.closed) throw new Error('relayer queue is closed');
    const jobId = String(job.callId);
    const delay = Math.max(0, delayMs);

    if (this.queue.upsertJobScheduler) {
      // Static scheduler template: BullMQ owns the timer, so jobs survive a
      // restart of this process.
      await this.queue.upsertJobScheduler(
        jobId,
        { every: delay },
        { name: 'resolve', data: job, opts: { jobId } },
      );
      return;
    }
    await this.queue.add('resolve', job, {
      jobId,
      delay: this.dynamicDelay ? delay : undefined,
    });
  }

  async cancel(callId: number): Promise<void> {
    const job = await this.queue.getJob(String(callId));
    if (job) await job.remove();
  }

  async pendingCount(): Promise<number> {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'delayed',
      'active',
    );
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.worker.close(), this.queue.close()]);
  }

  private async dispatch(job: ResolutionJob): Promise<void> {
    if (!this.processor) {
      throw new Error('no processor installed on the relayer queue');
    }
    await this.processor(job);
  }
}

/** Pick the queue implementation from the environment. */
export function createRelayerQueue(): ResolutionJobQueue {
  const driver = process.env.RELAYER_QUEUE_DRIVER ?? 'in-process';
  if (driver === 'bullmq') {
    try {
      return new BullMqRelayerQueue();
    } catch (err) {
      // Refusing to start is the safe failure: silently degrading to a
      // non-durable in-process queue would strand resolutions on restart.
      throw new Error(
        `failed to initialise the bullmq relayer queue: ${(err as Error).message}`,
      );
    }
  }
  return new InProcessRelayerQueue();
}

/** Opaque per-attempt identifier, used to tag mutex ownership. */
export function newLockToken(): string {
  return randomBytes(16).toString('hex');
}
