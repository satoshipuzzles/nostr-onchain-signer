export async function encryptDM(recipientPubkey: string, plaintext: string): Promise<{ content: string; kind: number }> {
  const nostr = (window as any).nostr;

  if (typeof nostr?.nip44?.encrypt === 'function') {
    const encrypted = await nostr.nip44.encrypt(recipientPubkey, plaintext);
    return { content: encrypted, kind: 14 };
  }

  if (typeof nostr?.nip04?.encrypt === 'function') {
    const encrypted = await nostr.nip04.encrypt(recipientPubkey, plaintext);
    return { content: encrypted, kind: 4 };
  }

  // PWA fallback: encrypt locally using private key from session storage
  try {
    const session = JSON.parse(sessionStorage.getItem('nostr_onchain_session_keys') || '[]');
    const activeIdx = JSON.parse(sessionStorage.getItem('nostr_onchain_active_index') || '0');
    const privateKey = session[activeIdx]?.privateKeyHex;
    if (privateKey && privateKey.length === 64) {
      const nip04 = await import('nostr-tools/nip04');
      const encrypted = await nip04.encrypt(privateKey as string, recipientPubkey, plaintext);
      return { content: encrypted, kind: 4 };
    }
  } catch (err) {
    console.warn('PWA NIP-04 encrypt fallback failed:', err);
  }

  console.warn('No encryption available — sending as plaintext kind 4');
  return { content: plaintext, kind: 4 };
}

export async function decryptDM(senderPubkey: string, content: string, kind: number): Promise<string> {
  const nostr = (window as any).nostr;

  try {
    if (kind === 14 && typeof nostr?.nip44?.decrypt === 'function') {
      return await nostr.nip44.decrypt(senderPubkey, content);
    }
    if (typeof nostr?.nip04?.decrypt === 'function') {
      return await nostr.nip04.decrypt(senderPubkey, content);
    }
  } catch {
    try {
      if (typeof nostr?.nip44?.decrypt === 'function') {
        return await nostr.nip44.decrypt(senderPubkey, content);
      }
    } catch {}
    try {
      if (typeof nostr?.nip04?.decrypt === 'function') {
        return await nostr.nip04.decrypt(senderPubkey, content);
      }
    } catch {}
  }

  // PWA fallback: decrypt locally using private key from session storage
  try {
    const session = JSON.parse(sessionStorage.getItem('nostr_onchain_session_keys') || '[]');
    const activeIdx = JSON.parse(sessionStorage.getItem('nostr_onchain_active_index') || '0');
    const privateKey = session[activeIdx]?.privateKeyHex;
    if (privateKey && privateKey.length === 64) {
      const nip04 = await import('nostr-tools/nip04');
      return await nip04.decrypt(privateKey as string, senderPubkey, content);
    }
  } catch {
    // fall through to plaintext heuristic
  }

  if (content.length < 500 && /\s/.test(content) && !content.includes('?iv=')) {
    return content;
  }

  return '(unable to decrypt)';
}
