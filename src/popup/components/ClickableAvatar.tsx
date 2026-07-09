import { useState } from 'react';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { safeImageUrl } from '@/lib/utils';

const SIZES = {
  xs: 'w-5 h-5 text-[8px]',
  sm: 'w-7 h-7 text-[10px]',
  md: 'w-9 h-9 text-xs',
  lg: 'w-10 h-10 text-sm',
  xl: 'w-12 h-12 text-sm',
  '2xl': 'w-14 h-14 text-base',
  '3xl': 'w-16 h-16 text-lg',
} as const;

interface Props {
  pubkey: string;
  picture?: string | null;
  name?: string;
  size?: keyof typeof SIZES;
  className?: string;
  border?: string;
}

export function ClickableAvatar({ pubkey, picture, name, size = 'md', className = '', border }: Props) {
  const { openProfile } = useProfilePopup();
  const [imgError, setImgError] = useState(false);
  const initial = (name || pubkey).charAt(0).toUpperCase();
  const s = SIZES[size];
  const showImage = picture && !imgError;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openProfile(pubkey);
      }}
      className={`flex-shrink-0 rounded-full cursor-pointer hover:ring-2 hover:ring-purple-400/60 transition-all ${className}`}
      title="View profile"
    >
      {showImage ? (
        <img
          src={safeImageUrl(picture!)}
          alt=""
          onError={() => setImgError(true)}
          className={`${s.split(' ').slice(0, 2).join(' ')} rounded-full object-cover bg-surface-700 ring-1 ring-white/10 ${border || ''}`}
        />
      ) : (
        <div className={`${s} rounded-full bg-gradient-to-br from-purple-600/40 to-blue-600/40 flex items-center justify-center font-bold text-white/80 ring-1 ring-white/10 ${border || ''}`}>
          {initial}
        </div>
      )}
    </button>
  );
}
