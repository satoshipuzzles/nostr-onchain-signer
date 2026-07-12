/**
 * Deployment update detection for the PWA.
 *
 * Installed PWAs and long-lived tabs kept serving stale bundles after new
 * deploys — users were reporting bugs that were already fixed. The build
 * writes /version.json with a unique id; the running app compares its baked-in
 * __APP_VERSION__ against it on startup, on tab focus, and every 5 minutes.
 * When they differ, we force a reload (or show a toast if the user is mid-flow).
 */

import { toast } from 'sonner';

declare const __APP_VERSION__: string;

const CHECK_INTERVAL_MS = 5 * 60_000;
let started = false;
let promptShown = false;

async function fetchLiveVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

function reloadToUpdate() {
  // Bypass HTTP cache for the shell document
  window.location.reload();
}

async function check(silent: boolean) {
  const live = await fetchLiveVersion();
  if (!live || live === __APP_VERSION__) return;

  // A new deploy is live. On startup we can reload immediately (nothing to
  // lose); later, prompt so we don't blow away in-progress input.
  if (silent) {
    reloadToUpdate();
    return;
  }
  if (promptShown) return;
  promptShown = true;
  toast.info('A new version is available', {
    duration: Infinity,
    action: { label: 'Update now', onClick: reloadToUpdate },
  });
}

export function startUpdateChecker() {
  if (started || typeof window === 'undefined') return;
  // Only meaningful for the deployed web app — dev server and the extension
  // popup don't serve /version.json
  if (__APP_VERSION__ === 'dev' || window.location.protocol.startsWith('chrome')) return;
  started = true;

  // Startup check: reload right away if stale (before the user does anything)
  check(true);

  setInterval(() => check(false), CHECK_INTERVAL_MS);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check(false);
  });
}
