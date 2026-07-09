import { useState } from 'react';
import { useAuth } from '@/popup/context/AuthContext';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { Feed } from './Feed';
import { ComposeNote } from '@/popup/components/ComposeNote';
import { Plus, X } from 'lucide-react';

export function FeedPage() {
  const { publicKey, following } = useAuth();
  const { openProfile } = useProfilePopup();
  const [refreshKey, setRefreshKey] = useState(0);
  const [showCompose, setShowCompose] = useState(false);

  return (
    <div className="relative">
      <Feed
        key={refreshKey}
        publicKey={publicKey}
        followingPubkeys={following}
        onViewProfile={openProfile}
      />

      {/* Compose overlay */}
      {showCompose && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <h2 className="text-base font-semibold">New Note</h2>
            <button
              onClick={() => setShowCompose(false)}
              className="p-2 hover:bg-white/10 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <ComposeNote
              onPublished={() => {
                setShowCompose(false);
                setRefreshKey(k => k + 1);
              }}
            />
          </div>
        </div>
      )}

      {/* Floating compose button */}
      {!showCompose && (
        <button
          onClick={() => setShowCompose(true)}
          className="fixed bottom-24 md:bottom-8 right-4 md:right-8 w-14 h-14 bg-gradient-to-br from-purple-500 to-purple-700 text-white rounded-full shadow-lg shadow-purple-500/30 flex items-center justify-center hover:scale-105 active:scale-95 transition-transform z-40"
        >
          <Plus className="w-6 h-6" />
        </button>
      )}
    </div>
  );
}
