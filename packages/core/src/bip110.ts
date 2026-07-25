/**
 * BIP-110 (Reduced Data Temporary Softfork) awareness.
 *
 * BIP-110 is a UASF-style temporary soft fork that restricts arbitrary data
 * in newly created outputs. Key consensus rules relevant to this wallet:
 *   - New output scriptPubKeys > 34 bytes are invalid, UNLESS the first
 *     opcode is OP_RETURN, in which case up to 83 bytes are valid.
 *   - Pre-existing UTXOs are permanently exempt.
 *
 * Deployment (modified BIP9, signal bit 4, 55% threshold):
 *   - Mandatory signaling window: blocks 961,632 – 963,647 (~Aug 2026).
 *     Enforcing nodes reject non-signaling blocks during this window.
 *   - Lock-in: no later than block 963,648.
 *   - Activation: block 965,664 (~Sep 1, 2026).
 *   - Rules expire automatically 52,416 blocks (~1 year) after activation.
 *
 * With low miner signaling, enforcing nodes (Bitcoin Knots variants) are
 * expected to diverge onto a minority chain during the mandatory window.
 * There is NO replay protection: a BIP-110-compliant transaction is valid on
 * both chains, while a transaction with an OP_RETURN script > 83 bytes is
 * valid ONLY on the main (non-enforcing) chain once the rules are active.
 */

export const BIP110_SIGNAL_BIT = 4;
export const BIP110_MANDATORY_SIGNAL_START = 961_632;
export const BIP110_MANDATORY_SIGNAL_END = 963_647; // inclusive
export const BIP110_LOCK_IN_HEIGHT = 963_648;
export const BIP110_ACTIVATION_HEIGHT = 965_664;
export const BIP110_ACTIVE_DURATION = 52_416;
export const BIP110_EXPIRY_HEIGHT = BIP110_ACTIVATION_HEIGHT + BIP110_ACTIVE_DURATION;

/** Max total scriptPubKey size for OP_RETURN outputs under BIP-110. */
export const BIP110_MAX_OP_RETURN_SCRIPT = 83;
/** Max scriptPubKey size for non-OP_RETURN outputs under BIP-110. */
export const BIP110_MAX_OUTPUT_SCRIPT = 34;

/**
 * Whether a block version signals readiness for BIP-110.
 * BIP9-style: top 3 bits must be 001, and the deployment bit must be set.
 */
export function blockSignalsBip110(version: number): boolean {
  // Use >>> to treat the version as unsigned 32-bit
  const v = version >>> 0;
  const topBits = v >>> 29;
  return topBits === 0b001 && (v & (1 << BIP110_SIGNAL_BIT)) !== 0;
}

export type Bip110Phase =
  | 'signaling'      // before the mandatory window
  | 'mandatory'      // enforcing nodes reject non-signaling blocks
  | 'locked_in'      // between lock-in and activation
  | 'active'         // rules enforced on the BIP-110 chain
  | 'expired';       // rules lifted

export interface Bip110Status {
  phase: Bip110Phase;
  /** Blocks until the next milestone (mandatory window / activation / expiry). */
  blocksToNext: number;
  nextMilestone: string;
  /** Rough wall-clock estimate for the next milestone (10 min/block). */
  nextEta: Date;
}

export function bip110Status(tipHeight: number): Bip110Status {
  const eta = (blocks: number) => new Date(Date.now() + blocks * 10 * 60 * 1000);

  if (tipHeight < BIP110_MANDATORY_SIGNAL_START) {
    const blocks = BIP110_MANDATORY_SIGNAL_START - tipHeight;
    return {
      phase: 'signaling',
      blocksToNext: blocks,
      nextMilestone: `Mandatory signaling begins at block ${BIP110_MANDATORY_SIGNAL_START.toLocaleString()}`,
      nextEta: eta(blocks),
    };
  }
  if (tipHeight <= BIP110_MANDATORY_SIGNAL_END) {
    const blocks = BIP110_LOCK_IN_HEIGHT - tipHeight;
    return {
      phase: 'mandatory',
      blocksToNext: blocks,
      nextMilestone: `Lock-in at block ${BIP110_LOCK_IN_HEIGHT.toLocaleString()}`,
      nextEta: eta(blocks),
    };
  }
  if (tipHeight < BIP110_ACTIVATION_HEIGHT) {
    const blocks = BIP110_ACTIVATION_HEIGHT - tipHeight;
    return {
      phase: 'locked_in',
      blocksToNext: blocks,
      nextMilestone: `Activation at block ${BIP110_ACTIVATION_HEIGHT.toLocaleString()}`,
      nextEta: eta(blocks),
    };
  }
  if (tipHeight < BIP110_EXPIRY_HEIGHT) {
    const blocks = BIP110_EXPIRY_HEIGHT - tipHeight;
    return {
      phase: 'active',
      blocksToNext: blocks,
      nextMilestone: `Rules expire at block ${BIP110_EXPIRY_HEIGHT.toLocaleString()}`,
      nextEta: eta(blocks),
    };
  }
  return {
    phase: 'expired',
    blocksToNext: 0,
    nextMilestone: 'BIP-110 rules have expired',
    nextEta: new Date(),
  };
}

export interface OpReturnCompliance {
  /** Total OP_RETURN scriptPubKey size in bytes (opcode + push + payload). */
  scriptSize: number;
  /** Valid under BIP-110 (script ≤ 83 bytes) → relays/confirms on BOTH chains. */
  bip110Compliant: boolean;
  /** Exceeds the old 80/83-byte standardness policy (needs Core 30+ relay). */
  needsModernRelay: boolean;
  summary: string;
}

/** Script size for an OP_RETURN with the given payload length (minimal push). */
export function opReturnScriptSize(payloadLen: number): number {
  if (payloadLen === 0) return 1;
  if (payloadLen <= 75) return 1 + 1 + payloadLen;          // direct push
  if (payloadLen <= 255) return 1 + 2 + payloadLen;         // OP_PUSHDATA1
  return 1 + 3 + payloadLen;                                 // OP_PUSHDATA2
}

export function checkOpReturnCompliance(payloadLen: number): OpReturnCompliance {
  const scriptSize = opReturnScriptSize(payloadLen);
  const compliant = scriptSize <= BIP110_MAX_OP_RETURN_SCRIPT;
  return {
    scriptSize,
    bip110Compliant: compliant,
    needsModernRelay: scriptSize > BIP110_MAX_OP_RETURN_SCRIPT,
    summary: compliant
      ? `${scriptSize}-byte script — BIP-110 compliant, valid on both chains`
      : `${scriptSize}-byte script — exceeds BIP-110's 83-byte limit; after activation this transaction is valid on the main chain only (and needs Core 30+ nodes to relay)`,
  };
}
