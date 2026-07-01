import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, Send, User, MessageCircle } from 'lucide-react';
import { safeImageUrl } from '@/lib/utils';
import { getCachedProfile } from '@/lib/nostr/cache';

interface Conversation {
  pubkey: string;
  lastMessage: string;
  lastTimestamp: number;
  unread: boolean;
}

interface DM {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  isMine: boolean;
}

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

function openRelay(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connection failed')); };
  });
}

export function Messages() {
  const { publicKey } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [messages, setMessages] = useState<DM[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (publicKey) loadConversations();
  }, [publicKey]);

  useEffect(() => {
    if (selectedPubkey && publicKey) loadMessages(selectedPubkey);
  }, [selectedPubkey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadConversations() {
    setLoading(true);
    try {
      const convMap = new Map<string, Conversation>();

      for (const relayUrl of DEFAULT_RELAYS) {
        try {
          const ws = await openRelay(relayUrl);
          const subId = `dms_${Date.now()}`;

          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => { ws.close(); resolve(); }, 8000);

            ws.onmessage = (ev: MessageEvent) => {
              try {
                const msg = JSON.parse(ev.data);
                if (msg[0] === 'EVENT' && msg[1] === subId) {
                  const event = msg[2];
                  const otherPubkey = event.pubkey === publicKey
                    ? event.tags.find((t: string[]) => t[0] === 'p')?.[1]
                    : event.pubkey;
                  if (!otherPubkey) return;

                  const existing = convMap.get(otherPubkey);
                  if (!existing || event.created_at > existing.lastTimestamp) {
                    convMap.set(otherPubkey, {
                      pubkey: otherPubkey,
                      lastMessage: '(encrypted)',
                      lastTimestamp: event.created_at,
                      unread: event.pubkey !== publicKey,
                    });
                  }
                }
                if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(); }
              } catch {}
            };

            ws.send(JSON.stringify(['REQ', subId,
              { kinds: [4], authors: [publicKey!], limit: 50 },
              { kinds: [4], '#p': [publicKey!], limit: 50 },
            ]));
          });
        } catch {}
      }

      const sorted = Array.from(convMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
      setConversations(sorted);

      const profileMap: Record<string, any> = {};
      for (const conv of sorted.slice(0, 20)) {
        const p = await getCachedProfile(conv.pubkey);
        if (p) profileMap[conv.pubkey] = p;
      }
      setProfiles(profileMap);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadMessages(peerPubkey: string) {
    setMessages([]);
    try {
      const ws = await openRelay(DEFAULT_RELAYS[0]);
      const subId = `dm_thread_${Date.now()}`;
      const dms: DM[] = [];

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 8000);

        ws.onmessage = (ev: MessageEvent) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg[0] === 'EVENT' && msg[1] === subId) {
              const event = msg[2];
              dms.push({
                id: event.id,
                pubkey: event.pubkey,
                content: event.content,
                created_at: event.created_at,
                isMine: event.pubkey === publicKey,
              });
            }
            if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(); }
          } catch {}
        };

        ws.send(JSON.stringify(['REQ', subId,
          { kinds: [4], authors: [publicKey!], '#p': [peerPubkey], limit: 100 },
          { kinds: [4], authors: [peerPubkey], '#p': [publicKey!], limit: 100 },
        ]));
      });

      const sorted = dms.sort((a, b) => a.created_at - b.created_at);

      // Try to decrypt NIP-04 encrypted messages
      if (typeof (window as any).nostr?.nip04?.decrypt === 'function') {
        for (const dm of sorted) {
          try {
            const other = dm.isMine ? peerPubkey : dm.pubkey;
            const decrypted = await (window as any).nostr.nip04.decrypt(other, dm.content);
            dm.content = decrypted;
          } catch {
            // Content might already be plaintext or encrypted with a different method
            // Leave as-is if it looks like readable text, otherwise mark it
            if (dm.content.includes('?iv=') || dm.content.length > 200 && !/\s/.test(dm.content)) {
              dm.content = '(encrypted - approval needed)';
            }
          }
        }
      }

      setMessages(sorted);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  async function handleSend() {
    if (!newMessage.trim() || !selectedPubkey || !publicKey) return;
    setSending(true);
    try {
      let encryptedContent = newMessage;

      if (typeof (window as any).nostr?.nip04?.encrypt === 'function') {
        encryptedContent = await (window as any).nostr.nip04.encrypt(selectedPubkey, newMessage);
      }

      const event = {
        kind: 4,
        content: encryptedContent,
        tags: [['p', selectedPubkey]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: publicKey,
      };

      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event },
        id: `dm_${Date.now()}`,
      });

      if (response?.result) {
        for (const relayUrl of DEFAULT_RELAYS) {
          try {
            const ws = await openRelay(relayUrl);
            ws.send(JSON.stringify(['EVENT', response.result]));
            setTimeout(() => ws.close(), 2000);
          } catch {}
        }

        setMessages(prev => [...prev, {
          id: response.result.id,
          pubkey: publicKey,
          content: newMessage,
          created_at: Math.floor(Date.now() / 1000),
          isMine: true,
        }]);
        setNewMessage('');
      }
    } catch (err) {
      console.error('Failed to send DM:', err);
    } finally {
      setSending(false);
    }
  }

  if (selectedPubkey) {
    const profile = profiles[selectedPubkey];
    const displayName = profile?.displayName || profile?.name || selectedPubkey.slice(0, 12) + '...';

    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <button onClick={() => setSelectedPubkey(null)} className="p-1.5 hover:bg-white/10 rounded-lg">
            <ArrowLeft className="w-5 h-5" />
          </button>
          {profile?.picture ? (
            <img src={safeImageUrl(profile.picture)} alt="" className="w-8 h-8 rounded-full object-cover" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center">
              <User className="w-4 h-4 text-gray-400" />
            </div>
          )}
          <p className="font-medium text-sm truncate">{displayName}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <p className="text-center text-gray-500 text-sm py-8">No messages yet</p>
          )}
          {messages.map((dm) => (
            <div key={dm.id} className={`flex ${dm.isMine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${
                dm.isMine ? 'bg-white text-black rounded-br-sm' : 'bg-white/10 text-white rounded-bl-sm'
              }`}>
                <p className="break-words">{dm.content}</p>
                <p className="text-[10px] mt-1 text-gray-500">
                  {new Date(dm.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder="Type a message..."
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-white/30"
            />
            <button
              onClick={handleSend}
              disabled={!newMessage.trim() || sending}
              className="p-2.5 bg-white text-black rounded-xl disabled:opacity-30 hover:bg-gray-200 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-bold">Messages</h1>
        <p className="text-xs text-gray-500">Encrypted DMs (NIP-04)</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-gray-500 text-sm animate-pulse">Loading conversations...</p>
          </div>
        )}

        {!loading && conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <MessageCircle className="w-12 h-12 text-gray-700 mb-3" />
            <p className="text-gray-500 text-sm text-center">No conversations yet</p>
            <p className="text-gray-600 text-xs text-center mt-1">DMs from signing requests and invoices will appear here</p>
          </div>
        )}

        {conversations.map((conv) => {
          const profile = profiles[conv.pubkey];
          const name = profile?.displayName || profile?.name || conv.pubkey.slice(0, 16) + '...';
          return (
            <button
              key={conv.pubkey}
              onClick={() => setSelectedPubkey(conv.pubkey)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors border-b border-white/5 text-left"
            >
              {profile?.picture ? (
                <img src={safeImageUrl(profile.picture)} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-gray-400" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium truncate">{name}</p>
                  <span className="text-[10px] text-gray-600 flex-shrink-0">
                    {new Date(conv.lastTimestamp * 1000).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-xs text-gray-500 truncate">{conv.lastMessage}</p>
              </div>
              {conv.unread && <div className="w-2 h-2 rounded-full bg-white flex-shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
