import { useState, useEffect, useRef } from 'react';
import { fetchBlockchainStatus, type BlockchainStatus } from '@/lib/bitcoin/ticker';
import { Zap, Blocks, DollarSign } from 'lucide-react';

export function StatusBar() {
  const [status, setStatus] = useState<BlockchainStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadStatus();
    intervalRef.current = setInterval(loadStatus, 60_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function loadStatus() {
    try {
      const s = await fetchBlockchainStatus();
      setStatus(s);
    } catch {}
  }

  if (!status) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-gray-500 bg-black border-b border-white/5 overflow-x-auto whitespace-nowrap">
      {status.btcPriceUsd > 0 && (
        <span className="flex items-center gap-1">
          <DollarSign className="w-3 h-3 text-white" />
          <span className="font-mono">${status.btcPriceUsd.toLocaleString()}</span>
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
