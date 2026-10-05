export interface StellarAsset {
  code: string;
  issuer: string;
  issuerName?: string;
  balance: string;
  limit?: string;
  decimals: number;
  trustline: boolean;
  sac: boolean;
  popular?: boolean;
}

export interface StellarAssetManagerOptions {
  horizonUrl: string;
  signal?: AbortSignal;
}

export const KNOWN_STELLAR_ASSETS: Array<Omit<StellarAsset, 'balance' | 'limit'>> = [
  { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', issuerName: 'Circle USDC', decimals: 6, trustline: true, sac: false, popular: true },
];

function decimalsFor(code: string, issuer: string): number {
  const known = KNOWN_STELLAR_ASSETS.find((asset) => asset.code === code && asset.issuer === issuer);
  return known?.decimals || 7;
}

export async function fetchStellarAssets(publicKey: string, options: StellarAssetManagerOptions): Promise<StellarAsset[]> {
  const response = await fetch(`${options.horizonUrl.replace(/\/+$/, '')}/accounts/${encodeURIComponent(publicKey)}`, { signal: options.signal });
  if (!response.ok) throw new Error(`Horizon account request failed (${response.status})`);
  const account = await response.json() as { balances?: Array<Record<string, unknown>> };
  const balances = account.balances || [];
  const assets = balances.map((balance) => {
    const code = String(balance.asset_code || balance.asset_type || 'XLM');
    const issuer = String(balance.asset_issuer || '');
    return {
      code,
      issuer,
      issuerName: String(balance.asset_issuer_name || ''),
      balance: String(balance.balance || '0'),
      limit: typeof balance.limit === 'string' ? balance.limit : undefined,
      decimals: decimalsFor(code, issuer),
      trustline: Boolean(issuer),
      sac: false,
      popular: KNOWN_STELLAR_ASSETS.some((asset) => asset.code === code && asset.issuer === issuer),
    } satisfies StellarAsset;
  });
  return assets.filter((asset) => asset.code !== 'XLM' || asset.issuer === '');
}

export function addMissingPopularAssets(assets: StellarAsset[]): StellarAsset[] {
  const existing = new Set(assets.map((asset) => `${asset.code}:${asset.issuer}`));
  const missing = KNOWN_STELLAR_ASSETS.filter((asset) => !existing.has(`${asset.code}:${asset.issuer}`)).map((asset) => ({ ...asset, balance: '0' }));
  return [...assets, ...missing];
}

export interface ChangeTrustRequest {
  assetCode: string;
  issuer: string;
  limit?: string;
}

export function buildChangeTrustRequests(assets: StellarAsset[], onlyMissing = true): ChangeTrustRequest[] {
  return assets.filter((asset) => !onlyMissing || !asset.trustline || asset.balance === '0').map((asset) => ({ assetCode: asset.code, issuer: asset.issuer, limit: asset.limit }));
}

export function formatStellarBalance(asset: StellarAsset): string {
  const value = Number(asset.balance);
  if (!Number.isFinite(value)) return asset.balance;
  return value.toLocaleString(undefined, { maximumFractionDigits: asset.decimals });
}
