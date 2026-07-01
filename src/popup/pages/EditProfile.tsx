import { useState, useRef } from 'react';
import { ArrowLeft, Save, Loader2, Upload, Image } from 'lucide-react';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { createProfileEvent, publishEvent } from '@/lib/nostr/discovery';
import { signEvent } from '@/lib/nostr/events';
import { uploadFile, validateFile } from '@/lib/nostr/upload';

interface Props {
  publicKey: string;
  privateKeyHex?: string;
  profile: ProfileMetadata | null;
  onSaved: (profile: ProfileMetadata) => void;
  onBack: () => void;
}

export function EditProfile({ publicKey, privateKeyHex, profile, onSaved, onBack }: Props) {
  const [name, setName] = useState(profile?.name || '');
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [picture, setPicture] = useState(profile?.picture || '');
  const [banner, setBanner] = useState(profile?.banner || '');
  const [about, setAbout] = useState(profile?.about || '');
  const [nip05, setNip05] = useState(profile?.nip05 || '');
  const [lud16, setLud16] = useState(profile?.lud16 || '');
  const [website, setWebsite] = useState(profile?.website || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUploadPicture() {
    fileInputRef.current?.click();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.error || 'Invalid file');
      return;
    }

    setUploading(true);
    setError('');
    try {
      const result = await uploadFile(file, publicKey);
      setPicture(result.url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);

    try {
      const newProfile: ProfileMetadata = {
        pubkey: publicKey,
        name: name || undefined,
        displayName: displayName || undefined,
        picture: picture || undefined,
        banner: banner || undefined,
        about: about || undefined,
        nip05: nip05 || undefined,
        lud16: lud16 || undefined,
        website: website || undefined,
      };

      const unsigned = createProfileEvent(newProfile, publicKey);

      let signed;
      if (privateKeyHex) {
        signed = signEvent(unsigned, privateKeyHex);
      } else {
        // Request signing from background
        const response = await chrome.runtime.sendMessage({
          type: 'nip07:signEvent',
          payload: { event: unsigned },
          id: `publish_${Date.now()}`,
        });
        if (response.error) throw new Error(response.error);
        signed = response.result;
      }

      const result = await publishEvent(signed);

      // Always save locally regardless of relay publish status
      await chrome.storage.local.set({
        [`profile_${publicKey}`]: newProfile,
        [`profile_${publicKey}_updated`]: Date.now(),
      });

      if (result.success.length > 0) {
        setSuccess(true);
        onSaved(newProfile);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        // Still save locally even if relay publish failed
        setSuccess(true);
        onSaved(newProfile);
        setError('Saved locally but failed to publish to relays. Will retry on next open.');
        setTimeout(() => { setSuccess(false); setError(''); }, 5000);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold">Edit Profile</h1>
      </div>

      <form onSubmit={handleSave} className="space-y-3 flex-1">
        {/* Picture preview */}
        {picture && (
          <div className="flex justify-center mb-2">
            <img src={picture} alt="" className="w-16 h-16 rounded-full object-cover bg-surface-700" />
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelected}
          className="hidden"
        />

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Display Name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your display name" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Username</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="username" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Profile Picture</label>
          <div className="flex gap-2">
            <input value={picture} onChange={(e) => setPicture(e.target.value)} placeholder="https://... or upload below" className="input-field text-sm flex-1" />
            <button
              type="button"
              onClick={handleUploadPicture}
              disabled={uploading}
              className="px-3 py-2 bg-nostr/20 text-nostr rounded-lg hover:bg-nostr/30 text-xs font-medium flex items-center gap-1"
            >
              {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              {uploading ? '...' : 'Upload'}
            </button>
          </div>
          <p className="text-[10px] text-gray-600 mt-1">Uploads to nostr.build (NIP-98)</p>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Banner URL</label>
          <input value={banner} onChange={(e) => setBanner(e.target.value)} placeholder="https://..." className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">About</label>
          <textarea value={about} onChange={(e) => setAbout(e.target.value)} placeholder="A bit about yourself..." className="input-field text-sm h-16 resize-none" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">NIP-05 Identifier</label>
          <input value={nip05} onChange={(e) => setNip05(e.target.value)} placeholder="you@domain.com" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Lightning Address</label>
          <input value={lud16} onChange={(e) => setLud16(e.target.value)} placeholder="you@getalby.com" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Website</label>
          <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://your.site" className="input-field text-sm" />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}
        {success && <p className="text-green-400 text-sm">Profile published successfully!</p>}

        <div className="pt-2">
          <button type="submit" disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Publishing...' : 'Save & Publish'}
          </button>
        </div>
      </form>
    </div>
  );
}
