import { CHAIN_INFO, type Chain } from '@/lib/bitcoin/chain';

/** Which chain a wallet or spend is on: purple XBT (BLAKE2b), orange BTC (SHA-256). */
export function ChainBadge({ chain, prefix = '', className = '' }: { chain: Chain; prefix?: string; className?: string }) {
  return (
    <span
      className={`inline-block align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded font-mono ${
        chain === 'xbt' ? 'bg-purple-500/20 text-purple-300' : 'bg-bitcoin/15 text-bitcoin'
      } ${className}`}
      title={CHAIN_INFO[chain].label}
    >
      {prefix}{CHAIN_INFO[chain].ticker}
    </span>
  );
}
