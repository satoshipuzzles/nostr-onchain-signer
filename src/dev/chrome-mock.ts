/**
 * Mock chrome.* APIs for standalone web development.
 * This lets you run the popup UI in a regular browser tab
 * without needing to load it as a Chrome extension.
 */

const storage: Record<string, unknown> = {};

const mockChrome = {
  runtime: {
    id: 'mock-extension-id',
    getURL: (path: string) => `/${path}`,
    sendMessage: async (message: { type: string; payload?: unknown; id: string }) => {
      console.log('[Mock Chrome] sendMessage:', message.type, message.payload);

      switch (message.type) {
        case 'vault:status':
          return {
            id: message.id,
            result: {
              exists: !!storage['vault'],
              unlocked: !!storage['__unlocked'],
              publicKey: storage['__publicKey'] as string | undefined,
            },
          };

        case 'vault:create':
        case 'vault:unlock': {
          // In dev mode, just pretend unlock works
          const { password } = (message.payload || {}) as { password?: string };
          if (storage['vault'] && password) {
            storage['__unlocked'] = true;
            // Return a deterministic dev pubkey
            const devPubkey = 'a'.repeat(64);
            storage['__publicKey'] = devPubkey;
            return { id: message.id, result: { publicKey: devPubkey } };
          }
          if (!storage['vault']) {
            return { id: message.id, error: 'No vault found' };
          }
          return { id: message.id, error: 'Invalid password' };
        }

        case 'vault:lock':
          storage['__unlocked'] = false;
          return { id: message.id, result: { locked: true } };

        case 'nip07:getPublicKey':
          return { id: message.id, result: storage['__publicKey'] };

        case 'nip07:getRelays':
          return { id: message.id, result: {} };

        case 'btc:getAddress':
          return {
            id: message.id,
            result: 'bc1p' + 'a'.repeat(58),
          };

        default:
          console.warn('[Mock Chrome] Unhandled message:', message.type);
          return { id: message.id, error: `Mock: unhandled ${message.type}` };
      }
    },
    onMessage: {
      addListener: () => {},
    },
  },
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        const result: Record<string, unknown> = {};
        for (const key of keyList) {
          if (storage[key] !== undefined) result[key] = storage[key];
        }
        return result;
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(storage, items);
      },
      remove: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        for (const key of keyList) delete storage[key];
      },
    },
  },
};

// Only inject if not already in a Chrome extension context
if (typeof globalThis.chrome === 'undefined' || !globalThis.chrome?.runtime?.id) {
  (globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;
}

export {};
