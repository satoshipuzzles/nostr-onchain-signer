import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, Save, Loader2, Upload, CheckCircle, AlertCircle, Image } from 'lucide-react';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { createProfileEvent, publishEvent } from '@/lib/nostr/discovery';
import { signEvent } from '@/lib/nostr/events';
import { uploadFile, validateFile } from '@/lib/nostr/upload';
import { createMessageId } from '@/shared/messages';

interface Props {
  publicKey: string;
  privateKeyHex?: string;
  profile: ProfileMetadata | null;
  onSaved: (profile: ProfileMetadata) => void;
  onBack: () => void;
}

const AUTOSAVE_DELAY = 1500;

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
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [publishStatus, setPublishStatus] = useState<'idle' | 'success' | 'partial' | 'failed'>('idle');
  const [publishDetails, setPublishDetails] = useState('');
  const [uploading, setUploading] = useState<'picture' | 'banner' | null>(null);
  const [autoSaved, setAutoSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const uploadTarget = useRef<'picture' | 'banner'>('picture');

  // Auto-save to local storage when fields change
  const autoSave = useCallback(() => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
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
      await chrome.storage.local.set({ [`profile_${publicKey}`]: newProfile });
      onSaved(newProfile);
      setAutoSaved(true);
      setTimeout(() => setAutoSaved(false), 2000);
    }, AUTOSAVE_DELAY);
  }, [name, displayName, picture, banner, about, nip05, lud16, website, publicKey, onSaved]);

  useEffect(() => {
    autoSave();
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [name, displayName, picture, banner, about, nip05, lud16, website]);

  function triggerUpload(target: 'picture' | 'banner') {
    uploadTarget.current = target;
    if (target === 'picture') {
      fileInputRef.current?.click();
    } else {
      bannerInputRef.current?.click();
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.error || 'Invalid file');
      return;
    }

    const target = uploadTarget.current;
    setUploading(target);
    setError('');
    try {
      const result = await uploadFile(file, publicKey);
      if (target === 'picture') {
        setPicture(result.url);
      } else {
        setBanner(result.url);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
      e.target.value = '';
    }
  }

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setPublishing(true);
    setPublishStatus('idle');

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
        const response = await chrome.runtime.sendMessage({
          type: 'nip07:signEvent',
          payload: { event: unsigned },
          id: createMessageId(),
        });
        if (response.error) throw new Error(response.error);
        signed = response.result;
      }

      // Save locally immediately
      await chrome.storage.local.set({
        [`profile_${publicKey}`]: newProfile,
        [`profile_${publicKey}_updated`]: Date.now(),
      });
      onSaved(newProfile);

      // Publish to relays
      const result = await publishEvent(signed);

      if (result.success.length > 0 && result.failed.length === 0) {
        setPublishStatus('success');
        setPublishDetails(`Published to ${result.success.length} relay${result.success.length > 1 ? 's' : ''}`);
      } else if (result.success.length > 0) {
        setPublishStatus('partial');
        setPublishDetails(`${result.success.length} ok, ${result.failed.length} failed`);
      } else {
        setPublishStatus('failed');
        setPublishDetails('Could not reach any relay. Saved locally.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setPublishStatus('failed');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Edit Profile</h1>
        {autoSaved && (
          <span className="text-[10px] text-green-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Saved
          </span>
        )}
      </div>

      <form onSubmit={handlePublish} className="space-y-3 flex-1">
        {/* Banner preview + upload */}
        <div className="relative rounded-xl overflow-hidden bg-surface-700 h-20 mb-2">
          {banner ? (
            <img src={banner} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-xs text-gray-600">No banner</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => triggerUpload('banner')}
            disabled={uploading === 'banner'}
            className="absolute bottom-2 right-2 px-2 py-1 bg-black/60 backdrop-blur-sm text-white rounded-lg text-[10px] font-medium flex items-center gap-1 hover:bg-black/80"
          >
            {uploading === 'banner' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Image className="w-3 h-3" />}
            {uploading === 'banner' ? 'Uploading...' : 'Upload Banner'}
          </button>
        </div>

        {/* Picture preview + upload */}
        <div className="flex items-center gap-3 -mt-8 ml-3 relative z-10">
          <div className="relative">
            {picture ? (
              <img src={picture} alt="" className="w-14 h-14 rounded-full object-cover bg-surface-700 border-3 border-surface-800" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 border-3 border-surface-800 flex items-center justify-center">
                <span className="text-lg font-bold text-white/50">?</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => triggerUpload('picture')}
              disabled={uploading === 'picture'}
              className="absolute -bottom-1 -right-1 w-6 h-6 bg-bitcoin rounded-full flex items-center justify-center shadow-lg"
            >
              {uploading === 'picture' ? <Loader2 className="w-3 h-3 animate-spin text-white" /> : <Upload className="w-3 h-3 text-white" />}
            </button>
          </div>
          <div className="pt-8">
            <p className="text-xs text-gray-500">Tap icons to upload via nostr.build</p>
          </div>
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelected} className="hidden" />
        <input ref={bannerInputRef} type="file" accept="image/*" onChange={handleFileSelected} className="hidden" />

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Display Name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your display name" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Username</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="username" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Profile Picture URL</label>
          <input value={picture} onChange={(e) => setPicture(e.target.value)} placeholder="https://... or use upload button above" className="input-field text-sm" />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Banner URL</label>
          <input value={banner} onChange={(e) => setBanner(e.target.value)} placeholder="https://... or use upload button above" className="input-field text-sm" />
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

        {/* Status messages */}
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {publishStatus === 'success' && (
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            <span>{publishDetails}</span>
          </div>
        )}
        {publishStatus === 'partial' && (
          <div className="flex items-center gap-2 text-yellow-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{publishDetails}</span>
          </div>
        )}
        {publishStatus === 'failed' && !error && (
          <div className="flex items-center gap-2 text-orange-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{publishDetails}</span>
          </div>
        )}

        <div className="pt-2 pb-4">
          <button type="submit" disabled={publishing} className="btn-primary w-full flex items-center justify-center gap-2">
            {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {publishing ? 'Publishing to relays...' : 'Publish Profile'}
          </button>
          <p className="text-[10px] text-gray-600 text-center mt-2">
            Fields auto-save locally as you type. Hit Publish to broadcast to Nostr relays.
          </p>
        </div>
      </form>
    </div>
  );
}
