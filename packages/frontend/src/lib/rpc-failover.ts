export interface RpcEndpoint {
  id: string;
  url: string;
  network: string;
}

export interface RpcHealthSnapshot {
  endpointId: string;
  url: string;
  healthy: boolean;
  latencyMs: number | null;
  ledger: number | null;
  consecutiveFailures: number;
  lastError?: string;
  checkedAt: number;
}

export interface RpcProbe {
  (endpoint: RpcEndpoint, signal?: AbortSignal): Promise<{ ledger: number; latencyMs: number }>;
}

export interface RpcFailoverOptions {
  endpoints: RpcEndpoint[];
  network: string;
  failureThreshold?: number;
  probeIntervalMs?: number;
  requestTimeoutMs?: number;
  probe?: RpcProbe;
}

async function defaultProbe(endpoint: RpcEndpoint, signal?: AbortSignal): Promise<{ ledger: number; latencyMs: number }> {
  const started = performance.now();
  const response = await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger', params: {} }), signal });
  if (!response.ok) throw new Error(`RPC ${response.status}`);
  const payload = await response.json() as { result?: { ledger?: number }; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message || 'RPC error');
  const ledger = Number(payload.result?.ledger);
  if (!Number.isFinite(ledger)) throw new Error('RPC returned no ledger');
  return { ledger, latencyMs: performance.now() - started };
}

export class RpcFailoverManager {
  private readonly endpoints: RpcEndpoint[];
  private readonly failureThreshold: number;
  private readonly probeIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly probe: RpcProbe;
  private readonly listeners = new Set<(snapshot: RpcHealthSnapshot) => void>();
  private readonly health = new Map<string, RpcHealthSnapshot>();
  private activeIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly options: RpcFailoverOptions) {
    if (options.endpoints.length === 0) throw new Error('At least one RPC endpoint is required');
    if (options.endpoints.some((endpoint) => endpoint.network !== options.network)) throw new Error('All RPC endpoints must use the same Stellar network');
    this.endpoints = options.endpoints;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.probeIntervalMs = options.probeIntervalMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 4_000;
    this.probe = options.probe ?? defaultProbe;
    this.endpoints.forEach((endpoint) => this.health.set(endpoint.id, { endpointId: endpoint.id, url: endpoint.url, healthy: true, latencyMs: null, ledger: null, consecutiveFailures: 0, checkedAt: 0 }));
  }

  get activeEndpoint(): RpcEndpoint {
    return this.endpoints[this.activeIndex];
  }

  get snapshots(): RpcHealthSnapshot[] {
    return this.endpoints.map((endpoint) => this.health.get(endpoint.id) as RpcHealthSnapshot);
  }

  subscribe(listener: (snapshot: RpcHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(snapshot: RpcHealthSnapshot): void {
    this.health.set(snapshot.endpointId, snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }

  private switchTo(endpointId: string): void {
    const index = this.endpoints.findIndex((endpoint) => endpoint.id === endpointId);
    if (index >= 0) this.activeIndex = index;
  }

  async checkEndpoint(endpoint = this.activeEndpoint): Promise<RpcHealthSnapshot> {
    const previous = this.health.get(endpoint.id) as RpcHealthSnapshot;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const result = await this.probe(endpoint, controller.signal);
      const snapshot: RpcHealthSnapshot = { ...previous, healthy: true, latencyMs: Math.round(result.latencyMs), ledger: result.ledger, consecutiveFailures: 0, lastError: undefined, checkedAt: Date.now() };
      this.publish(snapshot);
      return snapshot;
    } catch (caught) {
      const snapshot: RpcHealthSnapshot = { ...previous, healthy: false, latencyMs: null, consecutiveFailures: previous.consecutiveFailures + 1, lastError: caught instanceof Error ? caught.message : String(caught), checkedAt: Date.now() };
      this.publish(snapshot);
      if (snapshot.consecutiveFailures >= this.failureThreshold) {
        const fallback = this.endpoints.find((candidate) => candidate.id !== endpoint.id && (this.health.get(candidate.id)?.consecutiveFailures || 0) < this.failureThreshold);
        if (fallback) this.switchTo(fallback.id);
      }
      return snapshot;
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.checkEndpoint();
    this.timer = setInterval(() => { void this.checkEndpoint(); }, this.probeIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
  }
}

export function createRpcFailoverManager(options: RpcFailoverOptions): RpcFailoverManager {
  return new RpcFailoverManager(options);
}
