import { useAuth } from '@/popup/context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Feed } from './Feed';
import { ComposeNote } from '@/popup/components/ComposeNote';
import { useState } from 'react';
import { getCachedProfile } from '@/lib/nostr/cache';

export function FeedPage() {
  const { publicKey, following, setViewingUser } = useAuth();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

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
    <div className="h-full flex flex-col pb-20 md:pb-0">
      <div className="p-4 pb-2">
        <ComposeNote onPublished={() => setRefreshKey(k => k + 1)} />
      </div>
      <div className="flex-1 min-h-0">
        <Feed
          key={refreshKey}
          publicKey={publicKey}
          followingPubkeys={following}
          onBack={() => navigate('/')}
          onViewProfile={handleViewProfile}
        />
      </div>
    </div>
  );
}
