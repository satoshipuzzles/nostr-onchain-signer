import { useAuth } from '@/popup/context/AuthContext';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { Feed } from './Feed';

/**
 * The feed route. Composing happens inline at the top of the Following and
 * Global tabs (see Feed.tsx), so this wrapper only wires auth and profiles.
 */
export function FeedPage() {
  const { publicKey, following } = useAuth();
  const { openProfile } = useProfilePopup();

  return (
    <div className="relative">
      <Feed
        publicKey={publicKey}
        followingPubkeys={following}
        onViewProfile={openProfile}
      />
    </div>
  );
}
