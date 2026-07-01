import { useAuth } from '@/popup/context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Feed } from './Feed';
import { ComposeNote } from '@/popup/components/ComposeNote';
import { useState } from 'react';

export function FeedPage() {
  const { publicKey, following } = useAuth();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 pb-2">
        <ComposeNote onPublished={() => setRefreshKey(k => k + 1)} />
      </div>
      <div className="flex-1 min-h-0">
        <Feed
          key={refreshKey}
          publicKey={publicKey}
          followingPubkeys={following}
          onBack={() => navigate('/')}
        />
      </div>
    </div>
  );
}
