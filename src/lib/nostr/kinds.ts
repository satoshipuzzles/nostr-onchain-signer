/**
 * Custom Nostr event kinds for the Nostr Onchain Signer protocol.
 *
 * These extend the Nostr protocol to support Bitcoin multi-sig
 * coordination, onchain invoices, and signing round communication.
 *
 * All sensitive kinds (9733, 9800-9802) should be wrapped in
 * NIP-59 Gift Wrap (kind 1059) for privacy.
 *
 * ────────────────────────────────────────────────────────────────
 * KIND 9733 — ONCHAIN INVOICE
 * ────────────────────────────────────────────────────────────────
 * A request for on-chain Bitcoin payment. Similar to kind 9734
 * (zap request) but for Layer 1 transactions.
 *
 * Content: JSON {
 *   address: string,          // bc1p... Taproot address
 *   amount_sats?: number,     // Requested amount (0 = any)
 *   memo?: string,            // Human-readable description
 *   expires_at?: number,      // Unix timestamp expiry
 *   multisig_config?: {       // If paying to a multi-sig
 *     threshold: number,
 *     pubkeys: string[],
 *   }
 * }
 *
 * Tags:
 *   ["p", <recipient_pubkey>]
 *   ["a", <address>]            // Bitcoin address
 *   ["amount", <sats_string>]   // Amount in sats
 *
 * ────────────────────────────────────────────────────────────────
 * KIND 9800 — SIGNING REQUEST
 * ────────────────────────────────────────────────────────────────
 * A partially-signed Bitcoin transaction (PSBT) that needs
 * additional signatures from co-signers.
 *
 * Content: JSON {
 *   psbt_hex: string,              // Current PSBT state
 *   round_id: string,              // Unique signing round ID
 *   multisig_address: string,      // The multi-sig address being spent from
 *   threshold: number,             // Required signatures
 *   signed_count: number,          // How many have signed so far
 *   total_signers: number,         // Total possible signers
 *   memo?: string,                 // What this TX is for
 *   op_return_event_id?: string,   // If TX includes a Nostr note
 *   expires_at: number,            // Signing deadline
 * }
 *
 * Tags:
 *   ["p", <co_signer_pubkey>]      // Who this is addressed to
 *   ["r", <round_id>]             // Signing round reference
 *   ["a", <multisig_address>]     // Address being spent
 *
 * ────────────────────────────────────────────────────────────────
 * KIND 9801 — SIGNING RESPONSE
 * ────────────────────────────────────────────────────────────────
 * A co-signer's response containing their PSBT signature,
 * or a decline message.
 *
 * Content: JSON {
 *   round_id: string,
 *   psbt_hex?: string,       // PSBT with their signature added
 *   accepted: boolean,       // true = signed, false = declined
 *   message?: string,        // Optional note (e.g. "declined because...")
 * }
 *
 * Tags:
 *   ["p", <initiator_pubkey>]   // Back to the round initiator
 *   ["r", <round_id>]          // Which round
 *   ["e", <request_event_id>]  // References the signing request event
 *
 * ────────────────────────────────────────────────────────────────
 * KIND 9802 — SIGNING ROUND CHAT
 * ────────────────────────────────────────────────────────────────
 * Messages between co-signers during an active signing round.
 * Enables discussion about the transaction before signing.
 *
 * Content: JSON {
 *   round_id: string,
 *   message: string,
 * }
 *
 * Tags:
 *   ["r", <round_id>]              // Which round this is about
 *   ["p", <recipient_pubkey>] ...  // All participants
 */

export const CUSTOM_KIND = {
  ONCHAIN_INVOICE: 9733,
  SIGNING_REQUEST: 9800,
  SIGNING_RESPONSE: 9801,
  SIGNING_ROUND_CHAT: 9802,
  SOCIAL_UNLOCK: 9810,
  SOCIAL_UNLOCK_SIGN: 9811,
  SOCIAL_UNLOCK_REVEAL: 9812,
} as const;

// ─── Onchain Invoice ────────────────────────────────────────────

export interface OnchainInvoiceContent {
  address: string;
  amount_sats?: number;
  memo?: string;
  expires_at?: number;
  multisig_config?: {
    threshold: number;
    pubkeys: string[];
  };
}

export function createOnchainInvoice(
  invoice: OnchainInvoiceContent,
  recipientPubkey: string,
  myPubkey: string
) {
  const tags: string[][] = [
    ['p', recipientPubkey],
    ['a', invoice.address],
  ];
  if (invoice.amount_sats) {
    tags.push(['amount', invoice.amount_sats.toString()]);
  }

  return {
    kind: CUSTOM_KIND.ONCHAIN_INVOICE,
    content: JSON.stringify(invoice),
    tags,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}

export function parseOnchainInvoice(content: string): OnchainInvoiceContent | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// ─── Signing Request ────────────────────────────────────────────

export interface SigningRequestContent {
  psbt_hex: string;
  round_id: string;
  multisig_address: string;
  threshold: number;
  signed_count: number;
  total_signers: number;
  memo?: string;
  op_return_event_id?: string;
  expires_at: number;
  /** Nostr pubkeys of ALL key holders — lets the sign page verify eligibility */
  signer_pubkeys?: string[];
  amount_sats?: number;
  recipient?: string;
}

export function createSigningRequestEvent(
  request: SigningRequestContent,
  targetPubkey: string,
  myPubkey: string
) {
  return {
    kind: CUSTOM_KIND.SIGNING_REQUEST,
    content: JSON.stringify(request),
    tags: [
      ['p', targetPubkey],
      ['r', request.round_id],
      ['a', request.multisig_address],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}

/** Public index event for /sign/:roundId pages (no #p tag). */
export function createPublicSigningRequestEvent(
  request: SigningRequestContent,
  myPubkey: string,
) {
  return {
    kind: CUSTOM_KIND.SIGNING_REQUEST,
    content: JSON.stringify(request),
    tags: [
      ['r', request.round_id],
      ['a', request.multisig_address],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}

// ─── Signing Response ───────────────────────────────────────────

export interface SigningResponseContent {
  round_id: string;
  psbt_hex?: string;
  accepted: boolean;
  message?: string;
}

export function createSigningResponseEvent(
  response: SigningResponseContent,
  initiatorPubkey: string,
  requestEventId: string,
  myPubkey: string
) {
  return {
    kind: CUSTOM_KIND.SIGNING_RESPONSE,
    content: JSON.stringify(response),
    tags: [
      ['p', initiatorPubkey],
      ['r', response.round_id],
      ['e', requestEventId],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}

// ─── Signing Round Chat ─────────────────────────────────────────

export interface SigningChatContent {
  round_id: string;
  message: string;
}

export function createSigningChatEvent(
  chat: SigningChatContent,
  participantPubkeys: string[],
  myPubkey: string
) {
  const tags: string[][] = [['r', chat.round_id]];
  for (const pk of participantPubkeys) {
    tags.push(['p', pk]);
  }

  return {
    kind: CUSTOM_KIND.SIGNING_ROUND_CHAT,
    content: JSON.stringify(chat),
    tags,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}
