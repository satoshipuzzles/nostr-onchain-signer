import { useChain, CHAIN_INFO, type Chain } from '../lib/chain';

/** BTC / XBT toggle for the header. Persists across visits. */
export function ChainSwitch() {
  const [chain, setChain] = useChain();
  return (
    <div className="flex rounded-lg bg-ink-overlay p-0.5 text-xs font-semibold" role="group" aria-label="Chain">
      {(['btc', 'xbt'] as Chain[]).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => setChain(c)}
          title={`${CHAIN_INFO[c].label} — ${CHAIN_INFO[c].pow} proof of work`}
          className={`px-2.5 py-1 rounded-md transition-colors ${
            chain === c
              ? c === 'xbt' ? 'bg-purple-600 text-white' : 'bg-bitcoin text-black'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          {CHAIN_INFO[c].ticker}
        </button>
      ))}
    </div>
  );
}
