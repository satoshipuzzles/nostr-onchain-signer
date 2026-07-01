/**
 * PSBT Signing Round Coordination.
 *
 * Manages the flow of passing a partially-signed Bitcoin transaction
 * between multiple signers in a multi-sig setup. Uses Nostr encrypted
 * DMs (NIP-04/NIP-44) to relay PSBTs between participants.
 *
 * Flow:
 * 1. Initiator creates unsigned PSBT + signing round metadata
 * 2. Initiator signs their part, creates a SigningRound
 * 3. PSBT is sent to next signer via Nostr DM (NIP-17 preferred)
 * 4. Each signer adds their signature and passes it along
 * 5. Once threshold is met, the transaction can be broadcast
 */

export type SignerStatus = 'pending' | 'signed' | 'declined' | 'unreachable';

export interface SignerInfo {
  pubkey: string;
  displayName?: string;
  status: SignerStatus;
  signedAt?: number;
}

export interface SigningRound {
  id: string;
  multisigAddress: string;
  threshold: number;
  totalSigners: number;
  signers: SignerInfo[];
  psbtHex: string;         // Current state of the PSBT (accumulates signatures)
  createdAt: number;
  updatedAt: number;
  status: 'collecting' | 'ready' | 'broadcast' | 'expired';
  txid?: string;           // Set after broadcast
  expiresAt: number;
  memo?: string;           // Human-readable description
  opReturnEventId?: string; // If this TX includes a Nostr note
}

export interface SigningRequest {
  roundId: string;
  psbtHex: string;
  fromPubkey: string;
  multisigAddress: string;
  threshold: number;
  signedCount: number;
  totalSigners: number;
  memo?: string;
  expiresAt: number;
}

/**
 * Create a new signing round.
 */
export function createSigningRound(params: {
  multisigAddress: string;
  threshold: number;
  signerPubkeys: string[];
  psbtHex: string;
  memo?: string;
  opReturnEventId?: string;
  ttlHours?: number;
}): SigningRound {
  const now = Math.floor(Date.now() / 1000);
  const ttl = (params.ttlHours ?? 24) * 3600;

  return {
    id: generateRoundId(),
    multisigAddress: params.multisigAddress,
    threshold: params.threshold,
    totalSigners: params.signerPubkeys.length,
    signers: params.signerPubkeys.map((pubkey) => ({
      pubkey,
      status: 'pending',
    })),
    psbtHex: params.psbtHex,
    createdAt: now,
    updatedAt: now,
    status: 'collecting',
    expiresAt: now + ttl,
    memo: params.memo,
    opReturnEventId: params.opReturnEventId,
  };
}

/**
 * Record that a signer has signed the PSBT.
 */
export function recordSignature(
  round: SigningRound,
  signerPubkey: string,
  updatedPsbtHex: string
): SigningRound {
  const signers = round.signers.map((s) =>
    s.pubkey === signerPubkey
      ? { ...s, status: 'signed' as SignerStatus, signedAt: Math.floor(Date.now() / 1000) }
      : s
  );

  const signedCount = signers.filter((s) => s.status === 'signed').length;
  const status = signedCount >= round.threshold ? 'ready' : 'collecting';

  return {
    ...round,
    signers,
    psbtHex: updatedPsbtHex,
    updatedAt: Math.floor(Date.now() / 1000),
    status,
  };
}

/**
 * Mark a signer as declined.
 */
export function recordDecline(
  round: SigningRound,
  signerPubkey: string
): SigningRound {
  const signers = round.signers.map((s) =>
    s.pubkey === signerPubkey
      ? { ...s, status: 'declined' as SignerStatus }
      : s
  );

  return {
    ...round,
    signers,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get signing progress stats.
 */
export function getProgress(round: SigningRound): {
  signed: number;
  pending: number;
  declined: number;
  remaining: number;
  percentComplete: number;
  isReady: boolean;
  isExpired: boolean;
} {
  const now = Math.floor(Date.now() / 1000);
  const signed = round.signers.filter((s) => s.status === 'signed').length;
  const pending = round.signers.filter((s) => s.status === 'pending').length;
  const declined = round.signers.filter((s) => s.status === 'declined').length;
  const remaining = Math.max(0, round.threshold - signed);

  return {
    signed,
    pending,
    declined,
    remaining,
    percentComplete: Math.round((signed / round.threshold) * 100),
    isReady: signed >= round.threshold,
    isExpired: now > round.expiresAt,
  };
}

/**
 * Encode a signing request to send via Nostr DM.
 */
export function encodeSigningRequest(round: SigningRound): string {
  const request: SigningRequest = {
    roundId: round.id,
    psbtHex: round.psbtHex,
    fromPubkey: round.signers[0]?.pubkey ?? '',
    multisigAddress: round.multisigAddress,
    threshold: round.threshold,
    signedCount: round.signers.filter((s) => s.status === 'signed').length,
    totalSigners: round.totalSigners,
    memo: round.memo,
    expiresAt: round.expiresAt,
  };

  return JSON.stringify({ type: 'nostr-onchain-signer:signing-request', ...request });
}

/**
 * Decode a signing request from a Nostr DM.
 */
export function decodeSigningRequest(content: string): SigningRequest | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.type !== 'nostr-onchain-signer:signing-request') return null;
    return parsed as SigningRequest;
  } catch {
    return null;
  }
}

/**
 * Encode a signing response (signed PSBT) to send back.
 */
export function encodeSigningResponse(roundId: string, signedPsbtHex: string): string {
  return JSON.stringify({
    type: 'nostr-onchain-signer:signing-response',
    roundId,
    psbtHex: signedPsbtHex,
  });
}

/**
 * Decode a signing response.
 */
export function decodeSigningResponse(content: string): { roundId: string; psbtHex: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.type !== 'nostr-onchain-signer:signing-response') return null;
    return { roundId: parsed.roundId, psbtHex: parsed.psbtHex };
  } catch {
    return null;
  }
}

// Storage

export async function saveSigningRound(round: SigningRound): Promise<void> {
  const rounds = await loadSigningRounds();
  const idx = rounds.findIndex((r) => r.id === round.id);
  if (idx >= 0) {
    rounds[idx] = round;
  } else {
    rounds.push(round);
  }
  await chrome.storage.local.set({ signingRounds: rounds });
}

export async function loadSigningRounds(): Promise<SigningRound[]> {
  const result = await chrome.storage.local.get('signingRounds');
  const raw = result.signingRounds;
  if (!Array.isArray(raw)) return [];
  return raw;
}

export async function deleteSigningRound(id: string): Promise<void> {
  const rounds = await loadSigningRounds();
  await chrome.storage.local.set({
    signingRounds: rounds.filter((r) => r.id !== id),
  });
}

function generateRoundId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
