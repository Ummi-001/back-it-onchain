import { IRedisClient } from '../../../config/redis.config';

export class MockRedisClient implements IRedisClient {
  private readonly store = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  set(
    key: string,
    value: string,
    _mode: 'NX',
    _expiryMode: 'PX',
    ttlMs: number,
  ): Promise<string | null> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now())
      return Promise.resolve(null);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }

  pexpire(key: string, ttlMs: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + ttlMs;
    return Promise.resolve(1);
  }

  eval(script: string, _numkeys: number, ...args: string[]): Promise<unknown> {
    if (script.includes('redis.call') && args.length >= 2) {
      const [key, token] = args;
      const entry = this.store.get(key);
      if (entry && entry.value === token) {
        this.store.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }
    return Promise.resolve(0);
  }

  disconnect(): void {
    this.store.clear();
  }

  peek(key: string): { value: string; expiresAt: number } | undefined {
    return this.store.get(key);
  }
}
