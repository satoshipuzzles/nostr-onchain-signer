/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './popup.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bitcoin: '#FFFFFF',
        nostr: '#A0A0A0',
        surface: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#a3a3a3',
          400: '#737373',
          500: '#525252',
          600: '#262626',
          700: '#1a1a1a',
          800: '#0d0d0d',
          900: '#000000',
        },
      },
    },
  },
  plugins: [],
};
