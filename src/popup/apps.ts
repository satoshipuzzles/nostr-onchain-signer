import type { EmbedApp } from './context/EmbedPlayerContext';

/** Nostr apps that run embedded in the Audio, Games & Food section (and Vidstr's own tab). */

export const AUDIO_APPS: EmbedApp[] = [
  {
    id: 'cornychat',
    name: 'Corny Chat',
    url: 'https://cornychat.com',
    description: 'Nostr audio spaces — live voice rooms',
    kind: 'audio',
  },
  {
    id: 'hivetalk',
    name: 'HiveTalk',
    url: 'https://honey.hivetalk.org/',
    description: 'Nostr voice and video rooms — log in with Nostr, zap the speakers',
    kind: 'audio',
  },
];

export const GAME_APPS: EmbedApp[] = [
  {
    id: 'puzzl35',
    name: 'Puzzl35',
    url: 'https://puzzl35.com/',
    description: 'Turn anything into puzzles — Nostr-powered jigsaw puzzles with zaps',
    kind: 'game',
  },
  {
    id: 'word5',
    name: 'WORD5',
    url: 'https://otherstuff.ai/word5/',
    description: 'Daily 5-letter word game with Nostr login and streaks',
    kind: 'game',
  },
  {
    id: 'turdsoup',
    name: 'turdsoup',
    url: 'https://turdsoup.com',
    description: 'Guess the replies, a Nostr game',
    kind: 'game',
    logo: 'https://turdsoup.com/icon-512.png',
    npub: 'npub1fjz0p8mqu6g8nu86ndcjfrt5lzded3xzd5pafp7k76ek36h4nzzsn6d6kh',
    nip05: 'turdsoup@turdsoup.com',
  },
];

export const FOOD_APPS: EmbedApp[] = [
  {
    id: 'zapcooking',
    name: 'Zap Cooking',
    url: 'https://zap.cooking/explore',
    description: 'Recipes on Nostr — cook, share and zap the chefs',
    kind: 'food',
    logo: 'https://zap.cooking/favicon.svg',
    nip05: '_@zap.cooking',
  },
];

export const VIDSTR: EmbedApp = {
  id: 'vidstr',
  name: 'Vidstr',
  url: 'https://vidstr.nostronchain.com',
  description: 'Videos made to order, delivered on Nostr',
  kind: 'video',
  logo: 'https://vidstr.nostronchain.com/icon-512.png',
  npub: 'npub1qx2jtmtrf2chlvd3hnnpewsxjnkghqcvevfuzl83yqnzhmekw8nqsjn2uh',
  nip05: 'vidstr@nostronchain.com',
  route: '/vidstr',
};

export const VIDEO_APPS: EmbedApp[] = [VIDSTR];

export const ALL_APPS: EmbedApp[] = [...AUDIO_APPS, ...GAME_APPS, ...FOOD_APPS, ...VIDEO_APPS];
