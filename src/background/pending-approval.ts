/**
 * Queue external signing requests until the user approves in the extension popup.
 */

import type { ExtensionMessage, ExtensionResponse } from '@/shared/messages';

export interface PendingApproval {
  id: string;
  messageId: string;
  type: string;
  payload: unknown;
  origin: string;
  preview: string;
  pubkey?: string;
  createdAt: number;
}

type Waiter = {
  resolve: (response: ExtensionResponse) => void;
  message: ExtensionMessage;
};

const waiters = new Map<string, Waiter>();

const SIGNING_TYPES = new Set([
  'nip07:signEvent',
  'nip07:signSchnorr',
  'btc:signPsbt',
  'btc:signPsbtPartial',
]);

const OWN_APP_HOSTS = [
  'nostr-onchain-signer.vercel.app',
  'nostrfreaks.com',
  'www.nostrfreaks.com',
  'localhost',
  '127.0.0.1',
];

function isOwnAppUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return OWN_APP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function needsApproval(
  type: string,
  sender: chrome.runtime.MessageSender
): boolean {
  if (!SIGNING_TYPES.has(type)) return false;
  if (!sender.tab?.url) return false;
  const extPrefix = chrome.runtime.getURL('');
  if (sender.tab.url.startsWith(extPrefix)) return false;
  // Our own PWA — sign directly, no separate approval popup
  if (isOwnAppUrl(sender.tab.url)) return false;
  return true;
}

function pendingKey(id: string): string {
  return `pending_${id}`;
}

function buildPreview(type: string, payload: unknown): string {
  if (type === 'nip07:signEvent') {
    const event = (payload as { event?: { kind?: number; content?: string } })?.event;
    if (!event) return 'Sign Nostr event';
    const content = (event.content || '').slice(0, 200);
    return `Kind ${event.kind}\n${content}${(event.content || '').length > 200 ? '…' : ''}`;
  }
  if (type === 'nip07:signSchnorr') {
    const hash = (payload as { hash?: string })?.hash || '';
    return `Sign Bitcoin sighash\n${hash.slice(0, 64)}${hash.length > 64 ? '…' : ''}`;
  }
  if (type === 'btc:signPsbt' || type === 'btc:signPsbtPartial') {
    const psbt = (payload as { psbtHex?: string })?.psbtHex || '';
    return type === 'btc:signPsbtPartial'
      ? `Partial-sign PSBT (${psbt.length} hex chars)`
      : `Sign & finalize PSBT (${psbt.length} hex chars)`;
  }
  return 'Approve signing request';
}

export function queueForApproval(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  pubkey: string | undefined
): Promise<ExtensionResponse> {
  return new Promise(async (resolve) => {
    const id = crypto.randomUUID();
    const origin = sender.tab?.url || 'unknown';

    const pending: PendingApproval = {
      id,
      messageId: message.id,
      type: message.type,
      payload: message.payload,
      origin,
      preview: buildPreview(message.type, message.payload),
      pubkey,
      createdAt: Date.now(),
    };

    waiters.set(id, { resolve, message });
    await chrome.storage.session.set({ [pendingKey(id)]: pending });

    try {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#F7931A' });
    } catch {
      /* optional */
    }

    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL(`popup.html?approval=${id}`),
        type: 'popup',
        width: 420,
        height: 640,
        focused: true,
      });
    } catch {
      /* popup may already be open */
    }
  });
}

export async function getPendingApproval(
  approvalId: string
): Promise<PendingApproval | null> {
  const result = await chrome.storage.session.get(pendingKey(approvalId));
  return result[pendingKey(approvalId)] ?? null;
}

export function getWaiter(approvalId: string): Waiter | undefined {
  return waiters.get(approvalId);
}

export async function clearPendingApproval(approvalId: string): Promise<void> {
  waiters.delete(approvalId);
  await chrome.storage.session.remove(pendingKey(approvalId));

  if (waiters.size === 0) {
    try {
      await chrome.action.setBadgeText({ text: '' });
    } catch {
      /* optional */
    }
  }
}
