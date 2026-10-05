const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

let jwtToken: string | null = null;

export function setAuthToken(token: string | null) {
  jwtToken = token;
}

export function getAuthToken(): string | null {
  return jwtToken;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };

  if (jwtToken) {
    headers['Authorization'] = `Bearer ${jwtToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${init.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
};