/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0c0a09',
          raised: '#1c1917',
          overlay: '#292524',
        },
        accent: {
          DEFAULT: '#f97316',
          dim: '#c2410c',
        },
      },
    },
  },
  plugins: [],
};
