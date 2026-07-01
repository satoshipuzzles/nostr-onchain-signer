import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ProfileView as ProfileViewPage } from './ProfileView';

export function ProfileViewWrapper() {
  const navigate = useNavigate();
  const { viewingUser, following, handleFollow, handleUnfollow } = useAuth();

  if (!viewingUser) {
    navigate('/discover');
    return null;
  }

  return (
    <ProfileViewPage
      user={viewingUser}
      isFollowing={following.has(viewingUser.pubkey)}
      onFollow={() => handleFollow(viewingUser.pubkey)}
      onUnfollow={() => handleUnfollow(viewingUser.pubkey)}
      onBack={() => navigate(-1)}
    />
  );
}
