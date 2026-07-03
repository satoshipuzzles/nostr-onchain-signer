import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { safeImageUrl } from '@/lib/utils';

const SIZES = {
  xs: 'w-5 h-5 text-[8px]',
  sm: 'w-6 h-6 text-[9px]',
  md: 'w-8 h-8 text-xs',
  lg: 'w-9 h-9 text-xs',
  xl: 'w-10 h-10 text-sm',
  '2xl': 'w-12 h-12 text-sm',
  '3xl': 'w-14 h-14 text-base',
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
  const initial = (name || pubkey).charAt(0).toUpperCase();
  const s = SIZES[size];

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openProfile(pubkey);
      }}
      className={`flex-shrink-0 rounded-full cursor-pointer hover:ring-2 hover:ring-nostr/50 transition-all ${className}`}
      title="View profile"
    >
      {picture ? (
        <img
          src={safeImageUrl(picture)}
          alt=""
          className={`${s.split(' ').slice(0, 2).join(' ')} rounded-full object-cover bg-surface-700 ${border || ''}`}
        />
      ) : (
        <div className={`${s} rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center font-bold text-white/70 ${border || ''}`}>
          {initial}
        </div>
      )}
    </button>
  );
}
