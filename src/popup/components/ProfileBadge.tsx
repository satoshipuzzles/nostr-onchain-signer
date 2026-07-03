import { useState, useEffect } from 'react';
import { getCachedProfile } from '@/lib/nostr/cache';
import { safeImageUrl } from '@/lib/utils';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import type { ProfileMetadata } from '@/lib/nostr/social';

interface ProfileBadgeProps {
  pubkey: string;
  size?: 'sm' | 'md' | 'lg';
  showNip05?: boolean;
  showNpub?: boolean;
  onClick?: () => void;
}

export function ProfileBadge({ pubkey, size = 'md', showNip05 = true, showNpub = false, onClick }: ProfileBadgeProps) {
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);

  useEffect(() => {
    getCachedProfile(pubkey).then(p => { if (p) setProfile(p); });
  }, [pubkey]);

  const name = (typeof profile?.displayName === 'string' && profile.displayName)
    || (typeof profile?.name === 'string' && profile.name)
    || pubkey.slice(0, 8) + '...';
  const initial = name.charAt(0).toUpperCase();

  const sizes = {
    sm: { avatar: 'w-6 h-6', text: 'text-xs', sub: 'text-[9px]' },
    md: { avatar: 'w-8 h-8', text: 'text-sm', sub: 'text-xs' },
    lg: { avatar: 'w-10 h-10', text: 'text-sm', sub: 'text-xs' },
  };
  const s = sizes[size];

  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper onClick={onClick} className="flex items-center gap-2 min-w-0">
      {profile?.picture ? (
        <img src={safeImageUrl(profile.picture)} alt="" className={`${s.avatar} rounded-full object-cover bg-surface-700 flex-shrink-0`} />
      ) : (
        <div className={`${s.avatar} rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center flex-shrink-0`}>
          <span className="text-xs font-bold text-white/70">{initial}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className={`${s.text} font-medium truncate text-white`}>{name}</p>
        {showNip05 && typeof profile?.nip05 === 'string' && profile.nip05 && (
          <p className={`${s.sub} text-nostr/70 truncate`}>{profile.nip05}</p>
        )}
        {showNpub && (
          <p className={`${s.sub} text-gray-500 truncate font-mono`}>{pubkeyToNpub(pubkey).slice(0, 20)}...</p>
        )}
      </div>
    </Wrapper>
  );
}
