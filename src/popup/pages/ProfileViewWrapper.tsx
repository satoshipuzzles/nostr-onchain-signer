import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ProfileView as ProfileViewPage } from './ProfileView';
import { getCachedProfile } from '@/lib/nostr/cache';

export function ProfileViewWrapper() {
  const navigate = useNavigate();
  const { viewingUser, following, handleFollow, handleUnfollow, setViewingUser } = useAuth();

  if (!viewingUser) {
    navigate('/discover');
    return null;
  }

  async function handleViewProfile(pubkey: string) {
    const profile = await getCachedProfile(pubkey);
    setViewingUser({
      pubkey,
      lastActive: Math.floor(Date.now() / 1000),
      profile: profile || undefined,
    });
    navigate(`/discover/${pubkey}`);
  }

  return (
    <ProfileViewPage
      user={viewingUser}
      isFollowing={following.has(viewingUser.pubkey)}
      onFollow={() => handleFollow(viewingUser.pubkey)}
      onUnfollow={() => handleUnfollow(viewingUser.pubkey)}
      onBack={() => navigate(-1)}
      onViewProfile={handleViewProfile}
    />
  );
}
