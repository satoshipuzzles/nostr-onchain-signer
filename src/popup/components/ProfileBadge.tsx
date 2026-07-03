import { useState, useEffect } from 'react';
import { getCachedProfile } from '@/lib/nostr/cache';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import type { ProfileMetadata } from '@/lib/nostr/social';
import { ClickableAvatar } from './ClickableAvatar';

interface ProfileBadgeProps {
  pubkey: string;
  size?: 'sm' | 'md' | 'lg';
  showNip05?: boolean;
  showNpub?: boolean;
  onClick?: () => void;
}

const AVATAR_SIZE = { sm: 'sm', md: 'md', lg: 'xl' } as const;

export function ProfileBadge({ pubkey, size = 'md', showNip05 = true, showNpub = false, onClick }: ProfileBadgeProps) {
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);

  useEffect(() => {
    getCachedProfile(pubkey).then(p => { if (p) setProfile(p); });
  }, [pubkey]);

  const name = (typeof profile?.displayName === 'string' && profile.displayName)
    || (typeof profile?.name === 'string' && profile.name)
    || pubkey.slice(0, 8) + '...';

  const sizes = {
    sm: { text: 'text-xs', sub: 'text-[9px]' },
    md: { text: 'text-sm', sub: 'text-xs' },
    lg: { text: 'text-sm', sub: 'text-xs' },
  };
  const s = sizes[size];

  const nameContent = (
    <div className="min-w-0 flex-1">
      <p className={`${s.text} font-medium truncate text-white`}>{name}</p>
      {showNip05 && typeof profile?.nip05 === 'string' && profile.nip05 && (
        <p className={`${s.sub} text-nostr/70 truncate`}>{profile.nip05}</p>
      )}
      {showNpub && (
        <p className={`${s.sub} text-gray-500 truncate font-mono`}>{pubkeyToNpub(pubkey).slice(0, 20)}...</p>
      )}
    </div>
  );

  return (
    <div className="flex items-center gap-2 min-w-0">
      <ClickableAvatar
        pubkey={pubkey}
        picture={profile?.picture}
        name={name}
        size={AVATAR_SIZE[size]}
      />
      {onClick ? (
        <button onClick={onClick} className="min-w-0 flex-1 text-left">
          {nameContent}
        </button>
      ) : (
        nameContent
      )}
    </div>
  );
}
