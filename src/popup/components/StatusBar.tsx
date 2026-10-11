import { useState, useEffect, useRef } from 'react';
import { fetchBlockchainStatus, loadStatusBarChain, STATUS_BAR_CHAIN_EVENT, type BlockchainStatus } from '@/lib/bitcoin/ticker';
import { Zap, Blocks, DollarSign } from 'lucide-react';

export function StatusBar() {
  const [chain, setChain] = useState(loadStatusBarChain);
  const [status, setStatus] = useState<BlockchainStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const onChange = () => setChain(loadStatusBarChain());
    window.addEventListener(STATUS_BAR_CHAIN_EVENT, onChange);
    return () => window.removeEventListener(STATUS_BAR_CHAIN_EVENT, onChange);
  }, []);

  useEffect(() => {
    let live = true;
    async function loadStatus() {
      try {
        const s = await fetchBlockchainStatus(chain);
        if (live) setStatus(s);
      } catch {}
    }
    setStatus(null);
    loadStatus();
    intervalRef.current = setInterval(loadStatus, 60_000);
    return () => {
      live = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [chain]);

  if (!status) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-gray-500 bg-black border-b border-white/5 overflow-x-auto whitespace-nowrap">
      <span className="font-semibold text-gray-300" title={chain === 'xbt' ? 'XBT (BLAKE2b chain)' : 'BTC (SHA-256d chain)'}>
        {chain.toUpperCase()}
      </span>

      {status.btcPriceUsd > 0 && (
        <span className="flex items-center gap-1">
          <DollarSign className="w-3 h-3 text-white" />
          <span className="font-mono">
            {status.btcPriceUsd.toLocaleString(undefined, { maximumFractionDigits: status.btcPriceUsd < 10_000 ? 2 : 0 })}
          </span>
        </span>
      )}

      {status.blockHeight > 0 && (
        <span className="flex items-center gap-1">
          <Blocks className="w-3 h-3 text-gray-400" />
          <span className="font-mono">{status.blockHeight.toLocaleString()}</span>
        </span>
      )}

      <span className="flex items-center gap-1" title="Fee rates: fastest / half-hour / hour">
        <Zap className="w-3 h-3 text-gray-400" />
        <span className="font-mono">
          {status.fees.fastest}/{status.fees.halfHour}/{status.fees.hour} sat/vB
        </span>
      </span>
    </div>
  );
}
