import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AdminService } from '../admin/admin.service';
import { OracleService } from './oracle.service';
import { RedisClientProvider } from '../config/redis.config';
import {
  PRICE_PROVIDERS,
  PriceProvider,
  PriceQuote,
} from './providers/price-provider.interface';
import { MockRedisClient } from './providers/testing/mock-redis.client';

type FakeProvider = PriceProvider & { fetchMock: jest.Mock };

function quote(overrides: Partial<PriceQuote> & { price: number }): PriceQuote {
  return {
    source: 'test',
    volume24h: 100,
    timestamp: Date.now(),
    symbol: 'TEST',
    ...overrides,
  };
}

function fakeProvider(
  name: string,
  result: PriceQuote | null | Error,
): FakeProvider {
  const fetchMock = jest.fn(() =>
    result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve<PriceQuote | null>(result),
  );
  return { name, fetchQuote: fetchMock, fetchMock };
}

describe('OracleService.getAggregatedPrice (BE-011)', () => {
  let service: OracleService;
  let providers: PriceProvider[];
  let mockRedis: MockRedisClient;

  async function buildService(opts?: {
    providers?: PriceProvider[];
    redis?: MockRedisClient;
  }) {
    providers = opts?.providers ?? [];
    mockRedis = opts?.redis ?? new MockRedisClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => null) },
        },
        {
          provide: AdminService,
          useValue: { isPaused: jest.fn(() => false) },
        },
        { provide: PRICE_PROVIDERS, useValue: providers },
        {
          provide: RedisClientProvider,
          useValue: { getClient: () => mockRedis },
        },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
    return service;
  }

  it('aggregates three fresh quotes into the volume-weighted median', async () => {
    await buildService({
      providers: [
        fakeProvider(
          'dexscreener',
          quote({ source: 'dexscreener', price: 100, volume24h: 1000 }),
        ),
        fakeProvider(
          'geckoterminal',
          quote({ source: 'geckoterminal', price: 102, volume24h: 1000 }),
        ),
        fakeProvider(
          'pyth-stellar',
          quote({ source: 'pyth-stellar', price: 101, volume24h: 1000 }),
        ),
      ],
    });

    const result = await service.getAggregatedPrice('TEST');

    expect(result).not.toBeNull();
    expect(result!.price).toBe(101);
    expect(result!.sources).toEqual(
      expect.arrayContaining(['dexscreener', 'geckoterminal', 'pyth-stellar']),
    );
    expect(result!.confidence).toBe('high');
  });

  it('returns the sole fresh quote when only one provider succeeds', async () => {
    await buildService({
      providers: [
        fakeProvider('dexscreener', new Error('down')),
        fakeProvider('geckoterminal', null),
        fakeProvider(
          'pyth-stellar',
          quote({ source: 'pyth-stellar', price: 55 }),
        ),
      ],
    });

    const result = await service.getAggregatedPrice('TEST');

    expect(result).not.toBeNull();
    expect(result!.price).toBe(55);
    expect(result!.sources).toEqual(['pyth-stellar']);
    expect(result!.confidence).toBe('low');
  });

  it('returns null without throwing when every provider fails', async () => {
    await buildService({
      providers: [
        fakeProvider('dexscreener', new Error('down')),
        fakeProvider('geckoterminal', null),
        fakeProvider('pyth-stellar', new Error('down')),
      ],
    });

    await expect(service.getAggregatedPrice('TEST')).resolves.toBeNull();
  });

  it('drops quotes older than 5 minutes', async () => {
    await buildService({
      providers: [
        fakeProvider(
          'dexscreener',
          quote({
            source: 'dexscreener',
            price: 100,
            timestamp: Date.now() - 6 * 60 * 1000,
          }),
        ),
        fakeProvider('geckoterminal', null),
        fakeProvider('pyth-stellar', null),
      ],
    });

    const result = await service.getAggregatedPrice('TEST');

    expect(result).toBeNull();
  });

  it('rejects quotes deviating more than 10 percent from the median', async () => {
    await buildService({
      providers: [
        fakeProvider(
          'dexscreener',
          quote({ source: 'dexscreener', price: 100, volume24h: 1000 }),
        ),
        fakeProvider(
          'geckoterminal',
          quote({ source: 'geckoterminal', price: 102, volume24h: 1000 }),
        ),
        fakeProvider(
          'pyth-stellar',
          quote({ source: 'pyth-stellar', price: 200, volume24h: 10000 }),
        ),
      ],
    });

    const result = await service.getAggregatedPrice('TEST');

    expect(result).not.toBeNull();
    expect(result!.sources).not.toContain('pyth-stellar');
    expect(result!.sources).toEqual(
      expect.arrayContaining(['dexscreener', 'geckoterminal']),
    );
    expect(result!.price).toBe(100);
  });

  it('computes the volume-weighted median exactly for known weights', async () => {
    await buildService({
      providers: [
        fakeProvider(
          'dexscreener',
          quote({ source: 'dexscreener', price: 10, volume24h: 300 }),
        ),
        fakeProvider(
          'geckoterminal',
          quote({ source: 'geckoterminal', price: 20, volume24h: 300 }),
        ),
        fakeProvider(
          'pyth-stellar',
          quote({ source: 'pyth-stellar', price: 30, volume24h: 100 }),
        ),
      ],
    });

    const result = await service.getAggregatedPrice('TEST');

    expect(result!.price).toBe(20);
  });

  it('falls back to a simple median when total volume is zero', async () => {
    await buildService({
      providers: [
        fakeProvider(
          'dexscreener',
          quote({ source: 'dexscreener', price: 10, volume24h: 0 }),
        ),
        fakeProvider(
          'geckoterminal',
          quote({ source: 'geckoterminal', price: 20, volume24h: 0 }),
        ),
        fakeProvider(
          'pyth-stellar',
          quote({ source: 'pyth-stellar', price: 30, volume24h: 0 }),
        ),
      ],
    });

    const result = await service.getAggregatedPrice('TEST');

    expect(result!.price).toBe(20);
  });

  it('caches the result and skips providers on a second call within the TTL', async () => {
    const dex = fakeProvider(
      'dexscreener',
      quote({ source: 'dexscreener', price: 42, volume24h: 1000 }),
    );
    await buildService({ providers: [dex] });

    const first = await service.getAggregatedPrice('TEST');
    const second = await service.getAggregatedPrice('TEST');

    expect(first).toEqual(second);
    expect(dex.fetchMock).toHaveBeenCalledTimes(1);
    expect(mockRedis.peek('oracle:price:TEST')).toBeDefined();
  });

  it('queries all providers concurrently and does not short-circuit on failure', async () => {
    const slow = fakeProvider('dexscreener', new Error('down'));
    const ok = fakeProvider(
      'geckoterminal',
      quote({ source: 'geckoterminal', price: 7 }),
    );
    await buildService({ providers: [slow, ok] });

    const result = await service.getAggregatedPrice('TEST');

    expect(slow.fetchMock).toHaveBeenCalled();
    expect(ok.fetchMock).toHaveBeenCalled();
    expect(result!.price).toBe(7);
  });

  it('treats a provider that fails after its 2000 ms timeout as dropped', async () => {
    jest.useFakeTimers();

    const timeoutMock = jest.fn(
      () =>
        new Promise<PriceQuote | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 2_000);
          timer.unref?.();
        }),
    );
    const timesOut: FakeProvider = {
      name: 'times-out',
      fetchQuote: timeoutMock,
      fetchMock: timeoutMock,
    };
    const ok = fakeProvider(
      'geckoterminal',
      quote({ source: 'geckoterminal', price: 9 }),
    );

    await buildService({ providers: [timesOut, ok] });

    const pending = service.getAggregatedPrice('TEST');
    await jest.advanceTimersByTimeAsync(2_100);
    const result = await pending;

    expect(result!.price).toBe(9);
    expect(result!.sources).toEqual(['geckoterminal']);
    jest.useRealTimers();
  });

  it('does not serve a stale cached entry after the TTL has passed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);

    const provider = fakeProvider(
      'dexscreener',
      quote({ source: 'dexscreener', price: 42, volume24h: 1000 }),
    );
    await buildService({ providers: [provider], redis: new MockRedisClient() });

    await service.getAggregatedPrice('TEST');
    jest.setSystemTime(1_000_000 + 20_000);

    const result = await service.getAggregatedPrice('TEST');

    expect(provider.fetchMock).toHaveBeenCalledTimes(2);
    expect(result!.price).toBe(42);
    jest.useRealTimers();
  });

  it('normalizes the symbol to uppercase for the cache key', async () => {
    const provider = fakeProvider(
      'dexscreener',
      quote({ source: 'dexscreener', price: 5, volume24h: 10 }),
    );
    await buildService({ providers: [provider] });

    const upper = await service.getAggregatedPrice('TEST');
    const lower = await service.getAggregatedPrice('test');

    expect(lower).toEqual(upper);
    expect(provider.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for an empty symbol', async () => {
    await buildService({
      providers: [fakeProvider('dexscreener', quote({ price: 1 }))],
    });
    expect(await service.getAggregatedPrice('   ')).toBeNull();
  });
});

describe('Price provider adapters', () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  function okResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  it('DexScreenerProvider normalizes the best pair into a quote', async () => {
    const { DexScreenerProvider } =
      await import('./providers/dexscreener.provider');
    const provider = new DexScreenerProvider();

    global.fetch = jest.fn().mockResolvedValue(
      okResponse({
        pairs: [
          {
            priceUsd: '1.5',
            baseToken: { symbol: 'TEST' },
            volume: { h24: 5000 },
            liquidity: { usd: 100 },
          },
          {
            priceUsd: '2.0',
            baseToken: { symbol: 'TEST' },
            volume: { h24: 9000 },
            liquidity: { usd: 9000 },
          },
        ],
      }),
    );

    const result = await provider.fetchQuote('TEST');

    expect(result).not.toBeNull();
    expect(result!.price).toBe(2.0);
    expect(result!.source).toBe('dexscreener');
    expect(result!.volume24h).toBe(9000);
  });

  it('DexScreenerProvider returns null on HTTP failure', async () => {
    const { DexScreenerProvider } =
      await import('./providers/dexscreener.provider');
    const provider = new DexScreenerProvider();

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);

    await expect(provider.fetchQuote('TEST')).resolves.toBeNull();
  });
  it('GeckoTerminalProvider normalizes the token price into a quote', async () => {
    const { GeckoTerminalProvider } =
      await import('./providers/geckoterminal.provider');
    const config = { get: jest.fn(() => 'base') } as unknown as ConfigService;
    const provider = new GeckoTerminalProvider(config);

    global.fetch = jest.fn().mockResolvedValue(
      okResponse({
        data: {
          attributes: {
            token_prices: { '0xtest': '123.45' },
          },
        },
      }),
    );

    const result = await provider.fetchQuote('0xTEST');

    expect(result).not.toBeNull();
    expect(result!.price).toBe(123.45);
    expect(result!.source).toBe('geckoterminal');
  });

  it('PythStellarProvider applies the expo exponent and converts publish_time to ms', async () => {
    const { PythStellarProvider } =
      await import('./providers/pyth-stellar.provider');
    const provider = new PythStellarProvider();
    const publishTimeSec = Math.floor(Date.now() / 1000);

    global.fetch = jest.fn().mockResolvedValue(
      okResponse({
        parsed: [
          {
            id: 'feed',
            price: {
              price: '6140993501000',
              conf: '1',
              expo: -8,
              publish_time: publishTimeSec,
            },
          },
        ],
      }),
    );

    const result = await provider.fetchQuote('BTC');

    expect(result).not.toBeNull();
    expect(result!.price).toBeCloseTo(61409.93501, 5);
    expect(result!.timestamp).toBe(publishTimeSec * 1000);
  });

  it('PythStellarProvider returns null for an unknown symbol', async () => {
    const { PythStellarProvider } =
      await import('./providers/pyth-stellar.provider');
    const provider = new PythStellarProvider();

    await expect(provider.fetchQuote('NOPE')).resolves.toBeNull();
  });

  it('every adapter applies a 2000 ms AbortSignal timeout', async () => {
    const { DexScreenerProvider } =
      await import('./providers/dexscreener.provider');
    const { GeckoTerminalProvider } =
      await import('./providers/geckoterminal.provider');
    const { PythStellarProvider } =
      await import('./providers/pyth-stellar.provider');

    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false } as unknown as Response);

    const config = { get: jest.fn(() => 'base') } as unknown as ConfigService;

    await new DexScreenerProvider().fetchQuote('BTC');
    await new GeckoTerminalProvider(config).fetchQuote('BTC');
    await new PythStellarProvider().fetchQuote('BTC');

    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(timeoutSpy).toHaveBeenCalledWith(2000);
    timeoutSpy.mockRestore();
  });

  it('adapters return null when the request aborts on timeout', async () => {
    const { DexScreenerProvider } =
      await import('./providers/dexscreener.provider');
    const provider = new DexScreenerProvider();

    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('This operation was aborted'));

    await expect(provider.fetchQuote('BTC')).resolves.toBeNull();
  });
});

describe('AggregatedPrice confidence helper', () => {
  it('maps provider counts to confidence levels', async () => {
    const { confidenceForProviderCount } =
      await import('./providers/price-provider.interface');
    expect(confidenceForProviderCount(3)).toBe('high');
    expect(confidenceForProviderCount(2)).toBe('medium');
    expect(confidenceForProviderCount(1)).toBe('low');
  });
});
