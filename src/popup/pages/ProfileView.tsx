import { useState } from 'react';
import { ArrowLeft, Copy, Check, ExternalLink, BadgeCheck, Zap, Globe } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { type DiscoveredUser } from '@/lib/nostr/discovery';

interface Props {
  user: DiscoveredUser;
  isFollowing: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  onBack: () => void;
}

export function ProfileView({ user, isFollowing, onFollow, onUnfollow, onBack }: Props) {
  const [copied, setCopied] = useState('');
  const npub = pubkeyToNpub(user.pubkey);
  const profile = user.profile;

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* Banner / Header */}
      <div className="relative">
        {profile?.banner ? (
          <img src={profile.banner} alt="" className="w-full h-24 object-cover" />
        ) : (
          <div className="w-full h-24 bg-gradient-to-br from-bitcoin/20 to-nostr/20" />
        )}
        <button
          onClick={onBack}
          className="absolute top-3 left-3 btn-back bg-black/60 backdrop-blur"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
      </div>

      {/* Avatar */}
      <div className="px-4 -mt-8 relative z-10">
        {profile?.picture ? (
          <img
            src={profile.picture}
            alt=""
            className="w-16 h-16 rounded-full object-cover border-4 border-surface-900 bg-surface-700"
          />
        ) : (
          <div className="w-16 h-16 rounded-full border-4 border-surface-900 bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
            <span className="text-xl font-bold text-white/80">
              {(profile?.displayName || profile?.name || '?').charAt(0).toUpperCase()}
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-bold">
            {profile?.displayName || profile?.name || 'Unknown'}
          </h2>
          {profile?.nip05 && <BadgeCheck className="w-4 h-4 text-nostr" />}
        </div>

        {profile?.nip05 && (
          <p className="text-sm text-nostr/80 mb-2">{profile.nip05}</p>
        )}

        {profile?.about && (
          <p className="text-sm text-gray-400 mb-3 leading-relaxed">{profile.about}</p>
        )}

        {/* Metadata pills */}
        <div className="flex flex-wrap gap-2 mb-4">
          {profile?.lud16 && (
            <span className="flex items-center gap-1 text-xs bg-yellow-500/10 text-yellow-400 px-2 py-1 rounded-full">
              <Zap className="w-3 h-3" /> {profile.lud16}
            </span>
          )}
          {profile?.website && (
            <a
              href={profile.website}
              target="_blank"
              rel="noopener"
              className="flex items-center gap-1 text-xs bg-surface-700 text-gray-400 px-2 py-1 rounded-full hover:text-white"
            >
              <Globe className="w-3 h-3" /> {profile.website.replace(/^https?:\/\//, '')}
            </a>
          )}
        </div>

        {/* npub */}
        <div className="card mb-3">
          <p className="text-xs text-gray-500 mb-1">npub</p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {npub}
            </code>
            <button onClick={() => copy(npub, 'npub')} className="p-1 hover:bg-surface-700 rounded">
              {copied === 'npub' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>

        {/* Hex pubkey */}
        <div className="card mb-4">
          <p className="text-xs text-gray-500 mb-1">Hex Public Key</p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {user.pubkey}
            </code>
            <button onClick={() => copy(user.pubkey, 'hex')} className="p-1 hover:bg-surface-700 rounded">
              {copied === 'hex' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>

        {/* Follow/Unfollow */}
        <button
          onClick={isFollowing ? onUnfollow : onFollow}
          className={`w-full py-2.5 rounded-lg font-medium text-sm transition-colors ${
            isFollowing
              ? 'bg-surface-700 text-gray-300 hover:bg-red-500/20 hover:text-red-400'
              : 'btn-nostr'
          }`}
        >
          {isFollowing ? 'Unfollow' : 'Follow'}
        </button>
      </div>
    </div>
  );
}
