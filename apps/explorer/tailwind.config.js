/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#09090b',
          raised: '#18181b',
          overlay: '#27272a',
        },
        bitcoin: '#f7931a',
        nostr: '#a855f7',
      },
      maxWidth: {
        feed: '42rem',
      },
    },
  },
  plugins: [],
};
