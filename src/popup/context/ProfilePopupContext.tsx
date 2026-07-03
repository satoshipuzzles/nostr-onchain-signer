import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { ProfilePopup } from '@/popup/components/ProfilePopup';

interface ProfilePopupContextType {
  openProfile: (pubkey: string) => void;
  closeProfile: () => void;
}

const ProfilePopupContext = createContext<ProfilePopupContextType | null>(null);

export function useProfilePopup(): ProfilePopupContextType {
  const ctx = useContext(ProfilePopupContext);
  if (!ctx) throw new Error('useProfilePopup must be used within ProfilePopupProvider');
  return ctx;
}

export function ProfilePopupProvider({ children }: { children: ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(null);

  const openProfile = useCallback((pk: string) => {
    if (pk) setPubkey(pk);
  }, []);

  const closeProfile = useCallback(() => {
    setPubkey(null);
  }, []);

  return (
    <ProfilePopupContext.Provider value={{ openProfile, closeProfile }}>
      {children}
      {pubkey && <ProfilePopup pubkey={pubkey} onClose={closeProfile} />}
    </ProfilePopupContext.Provider>
  );
}
