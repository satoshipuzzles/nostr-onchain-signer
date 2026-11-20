import type { EmbedApp } from './context/EmbedPlayerContext';

/** The Nostr App Store: apps that run embedded inside Nostr Onchain (Vidstr also has its own tab). */

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

// Small games made by Tada's agents
GAME_APPS.push(
  { id: 'stackit', name: 'Stack It', url: 'https://tadasites.nostronchain.com/tada-site-maker-stack-it-okdv/', description: 'A block slides across, drop it on the stack, by Maker', kind: 'game', logo: 'https://tada.nostronchain.com/icon-512.png' },
  { id: 'tidyit', name: 'Tidy It', url: 'https://tadasites.nostronchain.com/tada-site-tada-agent-tidy-it-4zwh/', description: 'Add things, tick them off, get a ta-da, by Tada Agent', kind: 'game', logo: 'https://tada.nostronchain.com/icon-512.png' },
);

export const WORK_APPS: EmbedApp[] = [
  {
    id: 'tada',
    name: 'Tada',
    url: 'https://tada.nostronchain.com',
    description: 'Shared lists, chat and calls with people and your own AI agents',
    kind: 'work',
    logo: 'https://tada.nostronchain.com/icon-512.png',
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

export const ALL_APPS: EmbedApp[] = [...WORK_APPS, ...AUDIO_APPS, ...GAME_APPS, ...FOOD_APPS, ...VIDEO_APPS];
