import type {
  AppNotification,
  BotSettings,
  PaperPosition,
  PaperWallet,
  WalletLedgerEntry,
} from '../cx-engine/types';

export interface OfflineMarketSummary {
  sym: string;
  price: number;
  chg: number;
  vol: number;
  funding: number;
  score?: number;
  dir?: number;
  tier?: string;
  regime?: string;
  rsi?: number;
}

export interface OfflineSnapshot {
  wallet?: PaperWallet;
  trades?: PaperPosition[];
  ledger?: WalletLedgerEntry[];
  botSettings?: BotSettings;
  notifications?: AppNotification[];
  signals?: any[];
  market?: OfflineMarketSummary[];
  lastUpdatedAt: string;
}

const DB_NAME = 'cxp_offline_db';
const STORE_NAME = 'snapshots';
const SNAP_KEY = 'latest';
const LS_FALLBACK_KEY = 'cxp.offline.snapshot.v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveOfflineSnapshot(patch: Partial<OfflineSnapshot>): Promise<OfflineSnapshot> {
  const existing = await loadOfflineSnapshot().catch(() => null);
  const merged: OfflineSnapshot = {
    ...(existing || {}),
    ...patch,
    lastUpdatedAt: new Date().toISOString(),
  };

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(merged));
    }
  } catch {
    // ignore quota errors
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(merged, SNAP_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // localStorage fallback already written
  }

  return merged;
}

export async function loadOfflineSnapshot(): Promise<OfflineSnapshot | null> {
  try {
    const db = await openDb();
    const res = await new Promise<OfflineSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(SNAP_KEY);
      req.onsuccess = () => resolve((req.result as OfflineSnapshot) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (res) return res;
  } catch {
    // fallback to localStorage
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      if (raw) return JSON.parse(raw) as OfflineSnapshot;
    }
  } catch {
    // ignore
  }
  return null;
}
