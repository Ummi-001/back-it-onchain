export const PRICE_PROVIDERS = Symbol('PRICE_PROVIDERS');

export interface PriceQuote {
  source: string;
  price: number;
  volume24h: number;
  timestamp: number;
  symbol: string;
}

export interface PriceProvider {
  readonly name: string;
  fetchQuote(symbol: string): Promise<PriceQuote | null>;
}

export type PriceConfidence = 'high' | 'medium' | 'low';

export interface AggregatedPrice {
  symbol: string;
  price: number;
  sources: string[];
  timestamp: number;
  confidence: PriceConfidence;
}

export function confidenceForProviderCount(count: number): PriceConfidence {
  if (count >= 3) return 'high';
  if (count === 2) return 'medium';
  return 'low';
}
