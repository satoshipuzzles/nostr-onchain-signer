/**
 * App storage: settings (localStorage) + document library (IndexedDB).
 * Documents are the file-centric heart of the app: PSBTs, wallet manifests,
 * and notes, each with revision history.
 */

const SETTINGS_KEY = 'bwm_settings_v1';
const CONTACTS_KEY = 'bwm_contacts_v1';

export interface AppSettings {
  network: 'mainnet' | 'testnet';
  /** Ordered Esplora endpoints. First entry may be the user's own node. */
  esploraUrls: string[];
  /** Set when the user connects their own node (esplora/electrs REST). */
  ownNodeUrl?: string;
  relays: string[];
}

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { relays: DEFAULT_RELAYS, ...parsed };
    }
  } catch {
    // fall through to defaults
  }
  return {
    network: 'mainnet',
    esploraUrls: ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api'],
    relays: DEFAULT_RELAYS,
  };
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function effectiveEsploraUrls(settings: AppSettings): string[] {
  return settings.ownNodeUrl ? [settings.ownNodeUrl, ...settings.esploraUrls] : settings.esploraUrls;
}

// ─── Contacts ────────────────────────────────────────────────────

export interface Contact {
  pubkeyHex: string;
  npub: string;
  name: string;
  picture?: string;
  nip05?: string;
  /** Silent payment address published in their profile, if any. */
  silentPaymentAddress?: string;
  taprootAddress: string;
  addedAt: number;
}

export function loadContacts(): Contact[] {
  try {
    return JSON.parse(localStorage.getItem(CONTACTS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveContact(contact: Contact): void {
  const all = loadContacts().filter((c) => c.pubkeyHex !== contact.pubkeyHex);
  all.unshift(contact);
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(all.slice(0, 200)));
}

export function removeContact(pubkeyHex: string): void {
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(loadContacts().filter((c) => c.pubkeyHex !== pubkeyHex)));
}

// ─── Document library (IndexedDB) ────────────────────────────────

export type DocKind = 'psbt' | 'wallet' | 'labels' | 'note';

export interface DocRevision {
  at: number;
  data: string;
  note?: string;
}

export interface WalletDoc {
  id: string;
  kind: DocKind;
  name: string;
  /** Current content: base64 for PSBTs, JSON text for wallet files, text otherwise. */
  data: string;
  revisions: DocRevision[];
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'bwm';
const DB_VERSION = 1;
const STORE = 'docs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function listDocs(): Promise<WalletDoc[]> {
  const docs = await tx<WalletDoc[]>('readonly', (s) => s.getAll());
  return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id: string): Promise<WalletDoc | undefined> {
  return tx<WalletDoc | undefined>('readonly', (s) => s.get(id) as IDBRequest<WalletDoc | undefined>);
}

export async function createDoc(kind: DocKind, name: string, data: string): Promise<WalletDoc> {
  const now = Date.now();
  const doc: WalletDoc = {
    id: `doc_${now}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name,
    data,
    revisions: [{ at: now, data, note: 'Created' }],
    createdAt: now,
    updatedAt: now,
  };
  await tx('readwrite', (s) => s.put(doc));
  return doc;
}

export async function updateDoc(id: string, data: string, note?: string): Promise<WalletDoc> {
  const doc = await getDoc(id);
  if (!doc) throw new Error('Document not found');
  if (doc.data !== data) {
    doc.revisions.push({ at: Date.now(), data, note });
    if (doc.revisions.length > 50) doc.revisions = doc.revisions.slice(-50);
    doc.data = data;
    doc.updatedAt = Date.now();
    await tx('readwrite', (s) => s.put(doc));
  }
  return doc;
}

export async function renameDoc(id: string, name: string): Promise<void> {
  const doc = await getDoc(id);
  if (!doc) return;
  doc.name = name;
  doc.updatedAt = Date.now();
  await tx('readwrite', (s) => s.put(doc));
}

export async function deleteDoc(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
