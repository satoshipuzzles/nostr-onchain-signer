import { useEffect, useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';
import { getLogin, login, logout, fetchProfile, type Profile } from '../lib/nostr';

export function LoginButton() {
  const [pubkey, setPubkey] = useState<string | null>(getLogin());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (pubkey) fetchProfile(pubkey).then(setProfile).catch(() => {});
    else setProfile(null);
  }, [pubkey]);

  if (pubkey) {
    return (
      <button
        className="flex items-center gap-2 btn-ghost px-2"
        onClick={() => {
          logout();
          setPubkey(null);
        }}
        title="Logout"
      >
        {profile?.picture ? (
          <img src={profile.picture} alt="" className="w-7 h-7 rounded-full object-cover" />
        ) : (
          <span className="w-7 h-7 rounded-full bg-nostr/30 flex items-center justify-center text-xs font-bold">
            {(profile?.name ?? 'n').slice(0, 1).toUpperCase()}
          </span>
        )}
        <LogOut size={14} />
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        className="btn-nostr text-xs"
        onClick={async () => {
          setError('');
          try {
            setPubkey(await login());
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed');
            setTimeout(() => setError(''), 4000);
          }
        }}
      >
        <LogIn size={14} /> Login
      </button>
      {error && <div className="absolute right-0 top-full mt-2 w-64 card p-2 text-xs text-red-400 z-50">{error}</div>}
    </div>
  );
}
