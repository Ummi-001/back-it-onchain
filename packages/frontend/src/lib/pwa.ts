'use client';

export type NetworkStatus = 'online' | 'offline';

export interface QueuedDraft {
  id: string;
  payload: unknown;
  queuedAt: number;
  type?: 'draft' | 'bookmark' | 'comment' | 'transaction';
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  attempts?: number;
}

const DB_NAME = 'backit-offline-v1';
const STORE_NAME = 'actions';
const LEGACY_KEY = 'offline-draft-queue';
const SW_PATH = '/sw.js';

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isServiceWorkerSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in window.navigator;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function readLegacy(): QueuedDraft[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(LEGACY_KEY) || '[]');
    return Array.isArray(value) ? value as QueuedDraft[] : [];
  } catch {
    return [];
  }
}

export async function readDraftQueue(): Promise<QueuedDraft[]> {
  const database = await openDatabase();
  if (!database) return readLegacy();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const entries = await requestResult(transaction.objectStore(STORE_NAME).getAll());
    database.close();
    return (entries as QueuedDraft[]).sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    database.close();
    return readLegacy();
  }
}

export async function writeDraftQueue(queue: QueuedDraft[]): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    if (typeof window !== 'undefined') window.localStorage.setItem(LEGACY_KEY, JSON.stringify(queue));
    return;
  }
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  await requestResult(store.clear());
  for (const entry of queue) await requestResult(store.put(entry));
  database.close();
}

export async function queueDraft(payload: unknown, metadata: Partial<QueuedDraft> = {}): Promise<QueuedDraft> {
  const queue = await readDraftQueue();
  const entry: QueuedDraft = {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
    queuedAt: Date.now(),
    type: metadata.type || 'draft',
    url: metadata.url,
    method: metadata.method,
    headers: metadata.headers,
    body: metadata.body,
    attempts: 0,
  };
  await writeDraftQueue([...queue, entry]);
  await registerBackgroundSync();
  return entry;
}

export async function acknowledgeDraft(id: string): Promise<void> {
  const queue = await readDraftQueue();
  await writeDraftQueue(queue.filter((entry) => entry.id !== id));
}

export async function replayDraftQueue(replay?: (entry: QueuedDraft) => Promise<void>): Promise<{ synced: number; remaining: number }> {
  const queue = await readDraftQueue();
  let synced = 0;
  for (const entry of queue) {
    try {
      if (replay) await replay(entry);
      else if (entry.url) {
        const response = await fetch(entry.url, { method: entry.method || 'POST', headers: entry.headers, body: entry.body });
        if (!response.ok) throw new Error(`Queued action failed (${response.status})`);
      }
      await acknowledgeDraft(entry.id);
      synced += 1;
    } catch {
      break;
    }
  }
  const remaining = Math.max(0, (await readDraftQueue()).length);
  return { synced, remaining };
}

export async function drainDraftQueue(): Promise<QueuedDraft[]> {
  return readDraftQueue();
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return null;
  try {
    return await window.navigator.serviceWorker.register(SW_PATH, { scope: '/' });
  } catch {
    return null;
  }
}

export async function registerBackgroundSync(): Promise<void> {
  if (!isServiceWorkerSupported()) return;
  try {
    const registration = await window.navigator.serviceWorker.ready;
    const sync = (registration as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }).sync;
    await sync?.register('backit-offline-queue');
  } catch {
    return;
  }
}
