import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { TokenSearchResultDto } from './dto/token-search.dto';
import { OracleService } from '../oracle/oracle.service';

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

interface DexScreenerSearchResponse {
  pairs: DexScreenerPair[] | null;
}

interface GeckoTerminalPoolAttributes {
  address: string;
  name: string;
  base_token_price_usd?: string;
  reserve_in_usd?: string;
  volume_usd?: { h24?: string };
  pool_created_at?: string;
}

interface GeckoTerminalSearchResponse {
  data?: Array<{
    attributes: GeckoTerminalPoolAttributes;
    relationships?: { dex?: { data?: { id?: string } } };
  }>;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RESULTS = 20;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * BE-28 — proxies token discovery to DexScreener (primary) with a
 * GeckoTerminal fallback, normalizes results, and attaches a heuristic
 * liquidity/age/honeypot safety score. Results are cached for 5 minutes
 * per query to keep us within both providers' rate limits.
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Optional() private readonly oracleService?: OracleService,
  ) {}

  async getTokenPrice(symbol: string): Promise<{
    price: number | null;
    sources: string[];
    confidence: string;
  } | null> {
    if (!this.oracleService) {
      return null;
    }

    const aggregated = await this.oracleService.getAggregatedPrice(symbol);
    if (!aggregated) {
      return null;
    }

    return {
      price: aggregated.price,
      sources: aggregated.sources,
      confidence: aggregated.confidence,
    };
  }

  async search(query: string): Promise<TokenSearchResultDto[]> {
    const sanitized = query.trim();
    const cacheKey = `token-search:${sanitized.toLowerCase()}`;

    const cached = await this.cache.get<TokenSearchResultDto[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit: ${cacheKey}`);
      return cached;
    }

    const pairs = await this.fetchPairs(sanitized);
    const results = pairs.slice(0, MAX_RESULTS).map((pair) => this.toResult(pair));

    await this.cache.set(cacheKey, results, CACHE_TTL_MS);
    return results;
  }

  private async fetchPairs(query: string): Promise<DexScreenerPair[]> {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`DexScreener returned ${response.status}`);
      }

      const data = (await response.json()) as DexScreenerSearchResponse;
      return data?.pairs ?? [];
    } catch (err) {
      this.logger.warn(
        `DexScreener search failed for "${query}" (${(err as Error).message}), falling back to GeckoTerminal`,
      );
      return this.fetchPairsFromGeckoTerminal(query);
    }
  }

  private async fetchPairsFromGeckoTerminal(query: string): Promise<DexScreenerPair[]> {
    const url = `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`GeckoTerminal returned ${response.status}`);
      }

      const data = (await response.json()) as GeckoTerminalSearchResponse;

      return (data?.data ?? []).map(({ attributes, relationships }) => ({
        chainId: 'unknown',
        dexId: relationships?.dex?.data?.id ?? 'unknown',
        url: `https://www.geckoterminal.com/pools/${attributes.address}`,
        baseToken: {
          address: attributes.address,
          name: attributes.name,
          symbol: attributes.name,
        },
        priceUsd: attributes.base_token_price_usd,
        liquidity: { usd: Number(attributes.reserve_in_usd ?? 0) },
        volume: { h24: Number(attributes.volume_usd?.h24 ?? 0) },
        pairCreatedAt: attributes.pool_created_at
          ? new Date(attributes.pool_created_at).getTime()
          : undefined,
      }));
    } catch (err) {
      this.logger.error(
        `GeckoTerminal fallback also failed for "${query}": ${(err as Error).message}`,
      );
      return [];
    }
  }

  private toResult(pair: DexScreenerPair): TokenSearchResultDto {
    const liquidityUsd = pair.liquidity?.usd ?? 0;
    const volume24hUsd = pair.volume?.h24 ?? 0;
    const buys = pair.txns?.h24?.buys ?? 0;
    const sells = pair.txns?.h24?.sells ?? 0;

    return {
      address: pair.baseToken.address,
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      chainId: pair.chainId,
      dexId: pair.dexId,
      priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
      liquidityUsd,
      volume24hUsd,
      pairCreatedAt: pair.pairCreatedAt ?? null,
      safetyScore: this.computeSafetyScore({
        liquidityUsd,
        pairCreatedAt: pair.pairCreatedAt,
        buys,
        sells,
      }),
      url: pair.url,
    };
  }

  /**
   * Heuristic 0-100 safety score. Higher is safer.
   *  - Liquidity (0-40 pts): more USD locked in the pool reduces slippage
   *    and rug-pull risk. Saturates at $100k.
   *  - Age (0-30 pts): older pairs have had more time to prove themselves.
   *    Saturates at 30 days.
   *  - Txn pattern (0-30 pts): a token with only buys (or only sells) in
   *    the last 24h is a honeypot red flag — full points for a balanced
   *    buy/sell ratio, zero for entirely one-sided activity.
   */
  private computeSafetyScore(input: {
    liquidityUsd: number;
    pairCreatedAt?: number;
    buys: number;
    sells: number;
  }): number {
    const { liquidityUsd, pairCreatedAt, buys, sells } = input;

    let score = 0;

    score += Math.min(40, (liquidityUsd / 100_000) * 40);

    if (pairCreatedAt) {
      const ageDays = (Date.now() - pairCreatedAt) / (1000 * 60 * 60 * 24);
      score += Math.min(30, (ageDays / 30) * 30);
    }

    const totalTxns = buys + sells;
    if (totalTxns > 0) {
      const balance = 1 - Math.abs(buys - sells) / totalTxns;
      score += balance * 30;
    }

    return Math.round(Math.min(100, Math.max(0, score)));
  }
}
