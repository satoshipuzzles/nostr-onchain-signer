/**
 * Durable session for PWA mode.
 *
 * sessionStorage dies whenever the mobile OS kills the PWA process or the
 * user opens a new tab — which surfaced as random "Vault is locked" errors
 * mid-use. To survive restarts without storing plaintext keys, the decrypted
 * session is AES-GCM encrypted with a non-extractable device key kept in
 * IndexedDB, and the ciphertext lives in localStorage.
 *
 * Locking the vault wipes both the ciphertext and the device key.
 */

const DB_NAME = 'nostr-onchain-device';
const STORE = 'keys';
const DEVICE_KEY_ID = 'device-key';
const ENC_STORAGE_KEY = 'nostr_onchain_session_enc';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result as T | undefined);
    tx.onerror = () => reject(tx.error);
  });
}

function idbSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getDeviceKey(create: boolean): Promise<CryptoKey | null> {
  const db = await openDb();
  try {
    const existing = await idbGet<CryptoKey>(db, DEVICE_KEY_ID);
    if (existing) return existing;
    if (!create) return null;
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable — the raw key material never leaves the browser
      ['encrypt', 'decrypt'],
    );
    await idbSet(db, DEVICE_KEY_ID, key);
    return key;
  } finally {
    db.close();
  }
}

export async function persistSession(keys: unknown): Promise<void> {
  try {
    const deviceKey = await getDeviceKey(true);
    if (!deviceKey) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(keys));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, plaintext);
    const packed = {
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(ciphertext)),
    };
    localStorage.setItem(ENC_STORAGE_KEY, JSON.stringify(packed));
  } catch {
    // Persistence is best-effort — the in-tab session still works
  }
}

export async function restoreSession(): Promise<unknown | null> {
  try {
    const raw = localStorage.getItem(ENC_STORAGE_KEY);
    if (!raw) return null;
    const packed = JSON.parse(raw) as { iv: number[]; data: number[] };
    const deviceKey = await getDeviceKey(false);
    if (!deviceKey) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(packed.iv) },
      deviceKey,
      new Uint8Array(packed.data),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

export async function clearPersistedSession(): Promise<void> {
  try {
    localStorage.removeItem(ENC_STORAGE_KEY);
    const db = await openDb();
    try {
      await idbDelete(db, DEVICE_KEY_ID);
    } finally {
      db.close();
    }
  } catch { /* ignore */ }
}
