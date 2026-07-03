/**
 * Optional Bitcoin Core / compatible node pairing for broadcasting.
 * Falls back to public Esplora if node is unavailable.
 */

export interface BitcoinNodeConfig {
  enabled: boolean;
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
}

const STORAGE_KEY = 'bitcoin_node_config';

export async function loadBitcoinNodeConfig(): Promise<BitcoinNodeConfig | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw as BitcoinNodeConfig;
  if (!cfg.rpcUrl) return null;
  return cfg;
}

export async function saveBitcoinNodeConfig(config: BitcoinNodeConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

async function jsonRpcCall(
  config: BitcoinNodeConfig,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.rpcUser && config.rpcPassword) {
    headers.Authorization = `Basic ${btoa(`${config.rpcUser}:${config.rpcPassword}`)}`;
  }

  const isLocal = /localhost|127\.0\.0\.1/i.test(config.rpcUrl);
  const body = JSON.stringify({ jsonrpc: '1.0', id: 'nostr-onchain', method, params });

  if (isLocal) {
    const res = await fetch(config.rpcUrl, { method: 'POST', headers, body });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'RPC error');
    return data.result;
  }

  const res = await fetch('/api/bitcoin-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rpcUrl: config.rpcUrl,
      rpcUser: config.rpcUser,
      rpcPassword: config.rpcPassword,
      method,
      params,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error?.message || 'RPC failed';
    throw new Error(msg);
  }
  return data.result;
}

export async function testNodeConnection(config: BitcoinNodeConfig): Promise<{ ok: boolean; blocks?: number; error?: string }> {
  try {
    const result = await jsonRpcCall(config, 'getblockchaininfo', []) as { blocks?: number };
    return { ok: true, blocks: result?.blocks };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

export async function broadcastViaNode(config: BitcoinNodeConfig, rawTxHex: string): Promise<string> {
  const clean = rawTxHex.replace(/\s/g, '');
  const txid = await jsonRpcCall(config, 'sendrawtransaction', [clean]);
  if (typeof txid !== 'string' || !/^[a-f0-9]{64}$/i.test(txid)) {
    throw new Error('Invalid txid from node');
  }
  return txid;
}
