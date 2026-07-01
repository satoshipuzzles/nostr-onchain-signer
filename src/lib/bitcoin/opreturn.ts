/**
 * OP_RETURN Nostr note embedding for Bitcoin transactions.
 *
 * Encodes Nostr event data into OP_RETURN outputs that fit within
 * the 80-byte limit required by Bitcoin Knots and standard relay policy.
 *
 * Protocol format:
 *   OP_RETURN <protocol_id:4> <version:1> <kind:2> <event_id:32> = 39 bytes
 *
 * Extended format (with truncated content hash):
 *   OP_RETURN <protocol_id:4> <version:1> <kind:2> <event_id:32> <content_hash:20> = 59 bytes
 *
 * The remaining ~20 bytes can be used for additional metadata.
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

// "NSTR" in ASCII - 4-byte protocol identifier
const PROTOCOL_ID = new Uint8Array([0x4e, 0x53, 0x54, 0x52]);
const PROTOCOL_VERSION = 0x01;
const MAX_OP_RETURN = 80;

export interface NostrOpReturnData {
  eventId: string;   // 32-byte hex event ID
  kind: number;      // Nostr event kind
  content?: string;  // Optional content to hash
  pubkey?: string;   // Optional author pubkey (truncated)
}

export interface OpReturnOutput {
  script: Uint8Array;
  scriptHex: string;
  size: number;
  breakdown: {
    protocolId: string;
    version: number;
    kind: number;
    eventId: string;
    contentHash?: string;
  };
}

/**
 * Encode a Nostr event reference into an OP_RETURN script.
 *
 * Layout:
 *   [OP_RETURN(1)] [OP_PUSHDATA(1)] [payload(N)]
 *   Payload: [NSTR(4)] [version(1)] [kind(2 LE)] [event_id(32)]
 *   Optional: [content_hash_truncated(20)]
 *
 * Total with event_id only: 1 + 1 + 4 + 1 + 2 + 32 = 41 bytes
 * Total with content hash:  1 + 1 + 4 + 1 + 2 + 32 + 20 = 61 bytes
 */
export function encodeNostrOpReturn(data: NostrOpReturnData): OpReturnOutput {
  const eventIdBytes = hexToBytes(data.eventId);
  if (eventIdBytes.length !== 32) {
    throw new Error('Event ID must be 32 bytes');
  }

  // Kind as 2-byte little-endian
  const kindBytes = new Uint8Array(2);
  kindBytes[0] = data.kind & 0xff;
  kindBytes[1] = (data.kind >> 8) & 0xff;

  // Build payload
  let payload = concatBytes(
    PROTOCOL_ID,
    new Uint8Array([PROTOCOL_VERSION]),
    kindBytes,
    eventIdBytes
  );

  // Optionally add truncated content hash (first 20 bytes of SHA-256)
  if (data.content) {
    const contentHash = sha256(new TextEncoder().encode(data.content));
    const truncated = contentHash.slice(0, 20);
    payload = concatBytes(payload, truncated);
  }

  // Check size limit
  const scriptSize = 1 + 1 + payload.length; // OP_RETURN + push opcode + payload
  if (scriptSize > MAX_OP_RETURN) {
    throw new Error(
      `OP_RETURN script exceeds ${MAX_OP_RETURN} bytes: ${scriptSize}`
    );
  }

  // Build full script: OP_RETURN <push N bytes> <payload>
  const script = concatBytes(
    new Uint8Array([0x6a]),           // OP_RETURN
    new Uint8Array([payload.length]), // push data length
    payload
  );

  return {
    script,
    scriptHex: bytesToHex(script),
    size: script.length,
    breakdown: {
      protocolId: 'NSTR',
      version: PROTOCOL_VERSION,
      kind: data.kind,
      eventId: data.eventId,
      contentHash: data.content
        ? bytesToHex(sha256(new TextEncoder().encode(data.content)).slice(0, 20))
        : undefined,
    },
  };
}

/**
 * Decode an OP_RETURN script back into Nostr event reference data.
 */
export function decodeNostrOpReturn(scriptHex: string): NostrOpReturnData | null {
  const script = hexToBytes(scriptHex);

  // Minimum: OP_RETURN(1) + push(1) + NSTR(4) + ver(1) + kind(2) + eventId(32) = 41
  if (script.length < 41) return null;
  if (script[0] !== 0x6a) return null; // Not OP_RETURN

  const pushLen = script[1];
  const payload = script.slice(2, 2 + pushLen);

  // Check protocol ID
  if (
    payload[0] !== 0x4e ||
    payload[1] !== 0x53 ||
    payload[2] !== 0x54 ||
    payload[3] !== 0x52
  ) {
    return null; // Not our protocol
  }

  const version = payload[4];
  if (version !== PROTOCOL_VERSION) return null;

  const kind = payload[5] | (payload[6] << 8);
  const eventId = bytesToHex(payload.slice(7, 39));

  const result: NostrOpReturnData = { eventId, kind };

  // Check for content hash (20 bytes after event ID)
  if (payload.length >= 59) {
    // Content hash is present but we can't reverse it — just note it exists
  }

  return result;
}

/**
 * Verify that a given content matches the OP_RETURN content hash.
 */
export function verifyOpReturnContent(
  scriptHex: string,
  content: string
): boolean {
  const script = hexToBytes(scriptHex);
  if (script.length < 61) return false; // No content hash present

  const payload = script.slice(2);
  const storedHash = payload.slice(39, 59);
  const computedHash = sha256(new TextEncoder().encode(content)).slice(0, 20);

  return bytesToHex(storedHash) === bytesToHex(computedHash);
}

/**
 * Calculate the maximum content that can fit in the remaining OP_RETURN space.
 * Useful for showing the user how much metadata room they have left.
 */
export function remainingOpReturnBytes(includeContentHash: boolean): number {
  const baseSize = 2 + 4 + 1 + 2 + 32; // script overhead + protocol + ver + kind + eventId
  const contentHashSize = includeContentHash ? 20 : 0;
  return MAX_OP_RETURN - baseSize - contentHashSize;
}
