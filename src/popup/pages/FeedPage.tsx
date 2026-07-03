import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/popup/context/AuthContext';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { Feed } from './Feed';
import { ComposeNote } from '@/popup/components/ComposeNote';

export function FeedPage() {
  const { publicKey, following } = useAuth();
  const { openProfile } = useProfilePopup();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

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
          onViewProfile={openProfile}
        />
      </div>
    </div>
  );
}
