import { useState, useEffect } from 'react';
import { ArrowLeft, Send, Clock, Check, X, Circle, Radio, Loader2 } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import {
  type SigningRound,
  type SignerInfo,
  getProgress,
  loadSigningRounds,
} from '@/lib/bitcoin/signing-round';

interface Props {
  publicKey: string;
  onBack: () => void;
}

export function SigningRounds({ publicKey, onBack }: Props) {
  const [rounds, setRounds] = useState<SigningRound[]>([]);
  const [selectedRound, setSelectedRound] = useState<SigningRound | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRounds();
  }, []);

  async function loadRounds() {
    setLoading(true);
    const all = await loadSigningRounds();
    setRounds(all.sort((a, b) => b.updatedAt - a.updatedAt));
    setLoading(false);
  }

  if (selectedRound) {
    return (
      <RoundDetail
        round={selectedRound}
        onBack={() => setSelectedRound(null)}
      />
    );
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold">Signing Rounds</h1>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
        </div>
      ) : rounds.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
          <Radio className="w-8 h-8 mb-2 opacity-50" />
          <p className="text-sm">No active signing rounds</p>
          <p className="text-xs mt-1">Start one from "Send + Note"</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rounds.map((round) => (
            <RoundCard
              key={round.id}
              round={round}
              onClick={() => setSelectedRound(round)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoundCard({ round, onClick }: { round: SigningRound; onClick: () => void }) {
  const progress = getProgress(round);

  return (
    <button
      onClick={onClick}
      className="card w-full text-left hover:border-bitcoin/30 transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium truncate">
          {round.memo || `${round.threshold}-of-${round.totalSigners} TX`}
        </span>
        <StatusBadge status={round.status} />
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden mb-2">
        <div
          className="h-full bg-bitcoin rounded-full transition-all duration-500"
          style={{ width: `${progress.percentComplete}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{progress.signed}/{round.threshold} signatures</span>
        <span>{progress.remaining} more needed</span>
      </div>
    </button>
  );
}

function RoundDetail({ round, onBack }: { round: SigningRound; onBack: () => void }) {
  const progress = getProgress(round);

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold">Signing Progress</h1>
      </div>

      {/* Summary Card */}
      <div className="card mb-4">
        {round.memo && (
          <p className="text-sm text-gray-300 mb-3">{round.memo}</p>
        )}

        {/* Circular Progress */}
        <div className="flex items-center justify-center mb-4">
          <div className="relative w-24 h-24">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
              <circle
                cx="50" cy="50" r="42"
                fill="none"
                stroke="currentColor"
                strokeWidth="8"
                className="text-surface-700"
              />
              <circle
                cx="50" cy="50" r="42"
                fill="none"
                stroke="currentColor"
                strokeWidth="8"
                strokeDasharray={`${2 * Math.PI * 42}`}
                strokeDashoffset={`${2 * Math.PI * 42 * (1 - progress.percentComplete / 100)}`}
                strokeLinecap="round"
                className="text-bitcoin transition-all duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold text-bitcoin">{progress.signed}</span>
              <span className="text-xs text-gray-400">of {round.threshold}</span>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-lg font-bold text-green-400">{progress.signed}</p>
            <p className="text-xs text-gray-500">Signed</p>
          </div>
          <div>
            <p className="text-lg font-bold text-yellow-400">{progress.pending}</p>
            <p className="text-xs text-gray-500">Pending</p>
          </div>
          <div>
            <p className="text-lg font-bold text-red-400">{progress.declined}</p>
            <p className="text-xs text-gray-500">Declined</p>
          </div>
        </div>
      </div>

      {/* Signer List */}
      <h2 className="text-sm font-medium text-gray-400 mb-2">Signers</h2>
      <div className="space-y-1 flex-1 overflow-y-auto">
        {round.signers.map((signer, idx) => (
          <SignerRow key={signer.pubkey} signer={signer} index={idx} />
        ))}
      </div>

      {/* Action */}
      {progress.isReady && (
        <button className="btn-primary w-full mt-3 flex items-center justify-center gap-2">
          <Send className="w-4 h-4" />
          Broadcast Transaction
        </button>
      )}

      {progress.isExpired && round.status === 'collecting' && (
        <p className="text-center text-sm text-red-400 mt-3">
          This signing round has expired
        </p>
      )}

      {!progress.isReady && !progress.isExpired && (
        <div className="mt-3 text-center">
          <p className="text-sm text-gray-400">
            Waiting for {progress.remaining} more signature{progress.remaining > 1 ? 's' : ''}...
          </p>
        </div>
      )}
    </div>
  );
}

function SignerRow({ signer, index }: { signer: SignerInfo; index: number }) {
  const npub = pubkeyToNpub(signer.pubkey);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-800/50">
      {/* Status icon */}
      <div className="flex-shrink-0">
        {signer.status === 'signed' && (
          <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center">
            <Check className="w-3.5 h-3.5 text-green-400" />
          </div>
        )}
        {signer.status === 'pending' && (
          <div className="w-6 h-6 rounded-full bg-yellow-500/20 flex items-center justify-center">
            <Clock className="w-3.5 h-3.5 text-yellow-400" />
          </div>
        )}
        {signer.status === 'declined' && (
          <div className="w-6 h-6 rounded-full bg-red-500/20 flex items-center justify-center">
            <X className="w-3.5 h-3.5 text-red-400" />
          </div>
        )}
        {signer.status === 'unreachable' && (
          <div className="w-6 h-6 rounded-full bg-gray-500/20 flex items-center justify-center">
            <Circle className="w-3.5 h-3.5 text-gray-400" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">
          {signer.displayName || `Signer ${index + 1}`}
        </p>
        <p className="text-xs text-gray-500 truncate">
          {npub.slice(0, 16)}...{npub.slice(-6)}
        </p>
      </div>

      {/* Timestamp */}
      {signer.signedAt && (
        <span className="text-xs text-gray-500 flex-shrink-0">
          {formatTimestamp(signer.signedAt)}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: SigningRound['status'] }) {
  const styles = {
    collecting: 'bg-yellow-500/20 text-yellow-400',
    ready: 'bg-green-500/20 text-green-400',
    broadcast: 'bg-bitcoin/20 text-bitcoin',
    expired: 'bg-red-500/20 text-red-400',
  };

  const labels = {
    collecting: 'Collecting',
    ready: 'Ready',
    broadcast: 'Broadcast',
    expired: 'Expired',
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function formatTimestamp(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
