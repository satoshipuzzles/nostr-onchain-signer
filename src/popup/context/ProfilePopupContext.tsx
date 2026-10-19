import { createContext, useContext, useState, useCallback, type ReactNode, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
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

  // never left stranded: going to any page closes it, and so does Escape
  const location = useLocation();
  useEffect(() => { setPubkey(null); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!pubkey) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPubkey(null); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [pubkey]);

  return (
    <ProfilePopupContext.Provider value={{ openProfile, closeProfile }}>
      {children}
      {pubkey && <ProfilePopup pubkey={pubkey} onClose={closeProfile} />}
    </ProfilePopupContext.Provider>
  );
}
