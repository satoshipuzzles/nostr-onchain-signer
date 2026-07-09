/**
 * Shared message types for extension communication.
 * Used between content script <-> background <-> popup.
 */

export type MessageType =
  // NIP-07 messages
  | 'nip07:getPublicKey'
  | 'nip07:signEvent'
  | 'nip07:signSchnorr'
  | 'nip07:getRelays'
  | 'nip07:nip04:encrypt'
  | 'nip07:nip04:decrypt'
  | 'nip07:nip44:encrypt'
  | 'nip07:nip44:decrypt'
  // Bitcoin messages
  | 'btc:signPsbt'
  | 'btc:signPsbtPartial'
  | 'btc:getAddress'
  | 'btc:getMultisigAddress'
  // External signing approval
  | 'approval:get'
  | 'approval:confirm'
  | 'approval:reject'
  // Vault messages
  | 'vault:unlock'
  | 'vault:lock'
  | 'vault:status'
  | 'vault:create'
  | 'vault:switchAccount'
  // Dual-sign messages
  | 'dual:signAndBroadcast';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
  id: string;
}

export interface ExtensionResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface SignEventPayload {
  event: {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
  };
}

export interface SignPsbtPayload {
  psbtHex: string;
  inputsToSign?: number[];
}

export interface DualSignPayload {
  noteContent: string;
  noteTags?: string[][];
  recipientAddress: string;
  amountSats: number;
  feeRate: number;
}

export interface VaultStatusResponse {
  exists: boolean;
  unlocked: boolean;
  publicKey?: string;
}

export function createMessageId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
