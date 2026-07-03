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

  console.warn('No NIP-44 or NIP-04 encryption available');
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

  if (content.length < 500 && /\s/.test(content) && !content.includes('?iv=')) {
    return content;
  }

  return '(unable to decrypt)';
}
