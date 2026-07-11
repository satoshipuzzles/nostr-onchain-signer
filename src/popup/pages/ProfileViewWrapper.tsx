import { useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useProfilePopup } from '../context/ProfilePopupContext';
import { ProfileView as ProfileViewPage } from './ProfileView';
import { getCachedProfile } from '@/lib/nostr/cache';
import { type DiscoveredUser } from '@/lib/nostr/discovery';
import { Loader2 } from 'lucide-react';

export function ProfileViewWrapper() {
  const navigate = useNavigate();
  const { pubkey: routePubkey } = useParams<{ pubkey: string }>();
  const { viewingUser, following, handleFollow, handleUnfollow, setViewingUser } = useAuth();
  const { openProfile } = useProfilePopup();
  // Start in loading state when we still need to resolve the routed pubkey,
  // otherwise the first render (before the effect runs) would redirect away
  const [loading, setLoading] = useState(
    () => !!routePubkey && viewingUser?.pubkey !== routePubkey,
  );

  useEffect(() => {
    if (!routePubkey || viewingUser?.pubkey === routePubkey) return;

    let cancelled = false;
    setLoading(true);

    (async () => {
      const profile = await getCachedProfile(routePubkey);
      if (cancelled) return;
      const user: DiscoveredUser = {
        pubkey: routePubkey,
        profile: profile ?? undefined,
        lastActive: Math.floor(Date.now() / 1000),
      };
      setViewingUser(user);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [routePubkey, viewingUser?.pubkey, setViewingUser]);

  const user = viewingUser?.pubkey === routePubkey ? viewingUser : null;

  // Redirect as an effect, never during render
  useEffect(() => {
    if (loading || user) return;
    if (routePubkey) openProfile(routePubkey);
    navigate('/discover');
  }, [loading, user, routePubkey]);

  if (!user) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-bitcoin" />
      </div>
    );
  }

  return (
    <ProfileViewPage
      user={user}
      isFollowing={following.has(user.pubkey)}
      onFollow={() => handleFollow(user.pubkey)}
      onUnfollow={() => handleUnfollow(user.pubkey)}
      onBack={() => navigate(-1)}
      onViewProfile={openProfile}
    />
  );
}
