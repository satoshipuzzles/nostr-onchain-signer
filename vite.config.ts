import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';

// Unique per build — lets long-lived PWA sessions detect new deployments
const BUILD_VERSION = Date.now().toString(36);

function writeVersionFile() {
  return {
    name: 'write-version-file',
    closeBundle() {
      writeFileSync(
        resolve(__dirname, 'dist-web/version.json'),
        JSON.stringify({ version: BUILD_VERSION }),
      );
    },
  };
}

function copyExtensionFiles() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');

      copyFileSync(
        resolve(__dirname, 'manifest.prod.json'),
        resolve(dist, 'manifest.json')
      );

      copyFileSync(
        resolve(__dirname, 'src/content/nostr-provider.js'),
        resolve(dist, 'nostr-provider.js')
      );

      copyFileSync(
        resolve(__dirname, 'src/content/nostr-provider-bitcoin.js'),
        resolve(dist, 'nostr-provider-bitcoin.js')
      );

      const iconsDir = resolve(dist, 'icons');
      if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
      const srcIcons = resolve(__dirname, 'public/icons');
      if (existsSync(srcIcons)) {
        for (const size of ['16', '48', '128']) {
          const png = resolve(srcIcons, `icon-${size}.png`);
          if (existsSync(png)) copyFileSync(png, resolve(iconsDir, `icon-${size}.png`));
        }
      }
      const logo = resolve(__dirname, 'public/logo.png');
      if (existsSync(logo)) copyFileSync(logo, resolve(dist, 'logo.png'));
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const isServe = command === 'serve';
  const isWebBuild = mode === 'web';

  // Web build (for Vercel/PWA) — just build index.html as a regular SPA
  if (isWebBuild) {
    return {
      plugins: [react(), writeVersionFile()],
      resolve: {
        alias: { '@': resolve(__dirname, './src') },
      },
      build: {
        outDir: 'dist-web',
        emptyOutDir: true,
      },
      define: {
        'process.env': {},
        __APP_VERSION__: JSON.stringify(BUILD_VERSION),
      },
    };
  }

  // Dev server or extension build
  return {
    plugins: [react(), ...(!isServe ? [copyExtensionFiles()] : [])],
    resolve: {
      alias: { '@': resolve(__dirname, './src') },
    },
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
      __APP_VERSION__: JSON.stringify(isServe ? 'dev' : BUILD_VERSION),
    },
  };
});
