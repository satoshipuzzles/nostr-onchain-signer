import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Discover as DiscoverPage } from './Discover';

export function DiscoverWrapper() {
  const navigate = useNavigate();
  const { publicKey, following, handleFollow, handleUnfollow, setViewingUser } = useAuth();

  return (
    <DiscoverPage
      publicKey={publicKey}
      following={following}
      onFollow={handleFollow}
      onUnfollow={handleUnfollow}
      onViewProfile={(user) => {
        setViewingUser(user);
        navigate(`/discover/${user.pubkey}`);
      }}
      onBack={() => navigate(-1)}
    />
  );
}
