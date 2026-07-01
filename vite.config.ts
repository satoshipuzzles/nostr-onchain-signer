import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

function copyExtensionFiles() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');

      // Copy manifest.json
      copyFileSync(
        resolve(__dirname, 'manifest.prod.json'),
        resolve(dist, 'manifest.json')
      );

      // Copy nostr-provider.js
      copyFileSync(
        resolve(__dirname, 'src/content/nostr-provider.js'),
        resolve(dist, 'nostr-provider.js')
      );

      // Copy icons
      const iconsDir = resolve(dist, 'icons');
      if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
      const srcIcons = resolve(__dirname, 'public/icons');
      if (existsSync(srcIcons)) {
        for (const size of ['16', '48', '128']) {
          const file = `icon-${size}.png`;
          const src = resolve(srcIcons, file);
          if (existsSync(src)) copyFileSync(src, resolve(iconsDir, file));
        }
      }
    },
  };
}

export default defineConfig(({ command }) => {
  const isServe = command === 'serve';

  return {
    plugins: [react(), ...(!isServe ? [copyExtensionFiles()] : [])],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    // Dev server uses index.html at root; build uses popup.html for extension
    ...(isServe
      ? {}
      : {
          build: {
            outDir: 'dist',
            emptyOutDir: true,
            rollupOptions: {
              input: {
                popup: resolve(__dirname, 'popup.html'),
                background: resolve(__dirname, 'src/background/index.ts'),
                content: resolve(__dirname, 'src/content/inject.ts'),
              },
              output: {
                entryFileNames: (chunkInfo) => {
                  if (chunkInfo.name === 'background') return 'background.js';
                  if (chunkInfo.name === 'content') return 'content.js';
                  return 'assets/[name]-[hash].js';
                },
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash].[ext]',
              },
            },
          },
        }),
    define: {
      'process.env': {},
    },
  };
});
