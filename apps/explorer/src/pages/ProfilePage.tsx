import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, UserPlus, UserCheck, ExternalLink } from 'lucide-react';
import { pubkeyToTaprootAddress } from '@nostr-onchain/core';
import { anchorsForAddress, type AnchorRecord } from '../lib/scanner';
import {
  parsePubkeyInput,
  fetchProfile,
  followUser,
  isFollowing,
  getLogin,
  type Profile,
} from '../lib/nostr';
import { AnchorCard } from '../components/AnchorCard';
import { useChain, explorerAddressUrl, chainTicker } from '../lib/chain';

export function ProfilePage() {
  const { input } = useParams();
  const [chain] = useChain();
  const pubkey = input ? parsePubkeyInput(input) : null;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [anchors, setAnchors] = useState<AnchorRecord[] | null>(null);
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const me = getLogin();

  const address = pubkey ? pubkeyToTaprootAddress(pubkey) : null;

  useEffect(() => {
    if (!pubkey || !address) return;
    fetchProfile(pubkey).then(setProfile);
    setAnchors(null);
    setError('');
    anchorsForAddress(address, chain)
      .then((found) => setAnchors(found.sort((a, b) => b.blockHeight - a.blockHeight)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Chain lookup failed'));
    if (me) isFollowing(me, pubkey).then(setFollowing).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, chain]);

  if (!pubkey) {
    return (
      <div className="space-y-3">
        <p className="text-red-400 text-sm">Invalid profile — expected an npub, nprofile, or hex pubkey.</p>
        <Link to="/" className="btn-ghost text-xs"><ArrowLeft size={14} /> Feed</Link>
      </div>
    );
  }

  async function handleFollow() {
    if (!me || !pubkey) return;
    setBusy(true);
    try {
      await followUser(me, pubkey);
      setFollowing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Follow failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="btn-ghost text-xs -ml-2">
        <ArrowLeft size={14} /> Feed
      </Link>

      <div className="card p-5 space-y-4">
        <div className="flex items-start gap-4">
          {profile?.picture ? (
            <img src={profile.picture} alt="" className="w-16 h-16 rounded-full object-cover bg-ink-overlay" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-nostr/25 flex items-center justify-center text-2xl font-bold text-nostr">
              {(profile?.name ?? '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold truncate">{profile?.name ?? 'Loading…'}</h1>
            {profile?.nip05 && <div className="text-xs text-zinc-400">{profile.nip05}</div>}
            <div className="text-[11px] text-zinc-500 font-mono truncate">{profile?.npub}</div>
          </div>
          {me && me !== pubkey && (
            <button className={following ? 'btn-ghost text-xs' : 'btn-nostr text-xs'} onClick={handleFollow} disabled={busy || following === true}>
              {following ? <UserCheck size={14} /> : <UserPlus size={14} />}
              {following ? 'Following' : 'Follow'}
            </button>
          )}
        </div>
        {profile?.about && <p className="text-sm text-zinc-300 whitespace-pre-wrap">{profile.about}</p>}
        {address && (
          <div className="text-[11px] text-zinc-500 font-mono break-all">
            on-chain identity: {address}{' '}
            <a href={explorerAddressUrl('btc', address)} target="_blank" rel="noreferrer" className="text-bitcoin inline-flex items-center gap-0.5" title="On BTC (mempool.space)">
              BTC <ExternalLink size={10} />
            </a>{' '}
            <a href={explorerAddressUrl('xbt', address)} target="_blank" rel="noreferrer" className="text-purple-400 inline-flex items-center gap-0.5" title="On XBT (mempool.guide)">
              XBT <ExternalLink size={10} />
            </a>
          </div>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-zinc-300">
          On-chain anchors on {chainTicker(chain)} {anchors ? `(${anchors.length})` : ''}
        </h2>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {!anchors && !error && <div className="card h-24 animate-pulse" />}
        {anchors?.map((a) => (
          <AnchorCard key={a.id} anchor={a} />
        ))}
        {anchors && anchors.length === 0 && (
          <div className="card p-6 text-sm text-zinc-500 text-center">
            No OP_RETURN anchors published from this identity's taproot address yet.
          </div>
        )}
      </section>
    </div>
  );
}
