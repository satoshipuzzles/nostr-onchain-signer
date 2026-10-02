import { useEffect, useState } from 'react';
import {
  ArrowRight, Github, Radio, Globe, Key, Send, Rss, Trophy, Blocks, Users, Cpu,
  Download, Smartphone, GitFork,
} from 'lucide-react';
import { fetchMempoolApi, fetchFeeEstimates } from '@/lib/bitcoin/mempool';
import type { Chain } from '@/lib/bitcoin/chain';

interface Props {
  onGetStarted: () => void;
}

const GITHUB = 'https://github.com/satoshipuzzles/nostr-onchain-signer';

interface ChainStats {
  height: number | null;
  fee: number | null;
}

/** Tip height + "normal" fee for one chain, through the app's own proxy. Fails silently. */
async function loadChainStats(chain: Chain): Promise<ChainStats> {
  const out: ChainStats = { height: null, fee: null };
  try {
    const res = await fetchMempoolApi('/blocks/tip/height', 12_000, chain);
    if (res.ok) {
      const h = parseInt((await res.text()).trim(), 10);
      if (Number.isFinite(h)) out.height = h;
    }
  } catch { /* tile stays blank */ }
  try {
    const f = await fetchFeeEstimates(chain);
    if (Number.isFinite(f.halfHour)) out.fee = f.halfHour;
  } catch { /* tile stays blank */ }
  return out;
}

export function Landing({ onGetStarted }: Props) {
  const [xbt, setXbt] = useState<ChainStats>({ height: null, fee: null });
  const [btc, setBtc] = useState<ChainStats>({ height: null, fee: null });

  useEffect(() => {
    let alive = true;
    loadChainStats('xbt').then((s) => alive && setXbt(s));
    loadChainStats('btc').then((s) => alive && setBtc(s));
    return () => { alive = false; };
  }, []);

  return (
    <div className="min-h-screen overflow-y-auto overflow-x-hidden bg-black text-white text-[15px] leading-relaxed">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-black/80 border-b border-white/5">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Nostr Onchain" className="w-9 h-9 rounded-xl flex-shrink-0" />
            <span className="font-bold text-base">Nostr Onchain</span>
          </div>
          <button
            onClick={onGetStarted}
            className="text-sm px-5 py-2.5 bg-white text-black rounded-xl font-semibold hover:bg-gray-100 transition-colors"
          >
            Open the app
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.04)_0%,transparent_60%)]" />
        <div className="relative max-w-3xl mx-auto px-5 pt-20 pb-14 md:pt-28 md:pb-20 text-center">
          <img src="/logo.png" alt="" className="w-20 h-20 mx-auto mb-8 rounded-3xl" />
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-6 tracking-tight leading-[1.08]">
            Your Nostr key is a Bitcoin wallet.
          </h1>
          <p className="text-gray-300 text-lg md:text-xl max-w-2xl mx-auto mb-10">
            Every npub is a taproot address on XBT (the BLAKE2b Bitcoin chain run by Bitcoin Knots) and on BTC.
            Send, receive, split, do multisig and post to Nostr from one place.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onGetStarted}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-4 bg-white text-black rounded-2xl font-semibold text-base hover:bg-gray-100 transition-all active:scale-[0.98]"
            >
              Open the app <ArrowRight className="w-5 h-5" />
            </button>
            <button
              onClick={onGetStarted}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-4 border border-white/20 rounded-2xl font-medium text-gray-200 hover:bg-white/5 transition-all"
            >
              <Radio className="w-5 h-5" /> Login with your Pocket Signer bunker
            </button>
          </div>
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-6 text-sm text-gray-500 hover:text-white transition-colors"
          >
            <Github className="w-4 h-4" /> Source
          </a>
        </div>

        {/* Live tiles */}
        <div className="relative max-w-4xl mx-auto px-5 pb-16">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="XBT block height" value={fmtNum(xbt.height)} accent />
            <Tile label="XBT fee, sat per vbyte" value={fmtNum(xbt.fee)} accent />
            <Tile label="BTC block height" value={fmtNum(btc.height)} />
            <Tile label="BTC fee, sat per vbyte" value={fmtNum(btc.fee)} />
          </div>
          <p className="text-xs text-gray-600 text-center mt-3">Live from both chains. XBT is ahead because BLAKE2b blocks come faster since the split.</p>
        </div>
      </section>

      {/* Three ways in */}
      <section className="border-t border-white/5 bg-white/[0.015]">
        <div className="max-w-5xl mx-auto px-5 py-16 md:py-20">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-3">Three ways in</h2>
          <p className="text-gray-400 text-center mb-10 max-w-xl mx-auto">No account, no email. Pick where your key lives.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card icon={<Radio className="w-6 h-6" />} title="Pocket Signer or any bunker"
              text="Paste a bunker link (NIP-46). Your key never leaves the device; every transaction and note is approved on its screen." />
            <Card icon={<Globe className="w-6 h-6" />} title="Browser extension"
              text="Alby, nos2x, or Pocket Signer Link. The extension signs, this app builds and broadcasts." />
            <Card icon={<Key className="w-6 h-6" />} title="Generate a key here"
              text="A fresh key, encrypted in this browser with a password you choose. Back it up once and you are done." />
          </div>
        </div>
      </section>

      {/* Since the split */}
      <section className="border-t border-white/5">
        <div className="max-w-3xl mx-auto px-5 py-16 md:py-20">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center"><GitFork className="w-5 h-5" /></div>
            <h2 className="text-2xl md:text-3xl font-bold">Since the split</h2>
          </div>
          <div className="space-y-4 text-gray-300 text-base md:text-lg">
            <p>Bitcoin split at block 961,632. One chain kept SHA-256 mining (BTC); the other, run by Bitcoin Knots, is XBT.</p>
            <p>From block 961,640 XBT mines with BLAKE2b and supports a replay-safe signature type, SIGHASH_UNIFIED, that only verifies on XBT.</p>
            <p>Coins from before the split exist on both chains, and an ordinary signature moves them on both.</p>
            <p>The app's Split button sends those coins to yourself on XBT with the replay-safe signature. After that confirms, the BTC copies are yours to spend on BTC without touching your XBT.</p>
          </div>
          <a href="https://nostrtx.com" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-6 text-sm text-gray-400 hover:text-white transition-colors">
            Read how splitting works <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </section>

      {/* What's inside */}
      <section className="border-t border-white/5 bg-white/[0.015]">
        <div className="max-w-5xl mx-auto px-5 py-16 md:py-20">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-10">What's inside</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card icon={<Send className="w-6 h-6" />} title="Send"
              text="XBT or BTC. Pick exact coins, attach an OP_RETURN note, sign on your own device." />
            <Card icon={<Rss className="w-6 h-6" />} title="Feed"
              text="A full Nostr client: follow, post, reply, zap. Your social graph is your address book." />
            <Card icon={<Trophy className="w-6 h-6" />} title="Leaderboard"
              text="Who holds the most XBT on their npub, from your follows or the whole network." />
            <Card icon={<Blocks className="w-6 h-6" />} title="Explorer"
              text="Blocks and addresses on both chains, with a chain-split monitor and per-coin split status." />
            <Card icon={<Users className="w-6 h-6" />} title="Multisig"
              text="Taproot multisig built from npubs. Co-signers do nothing until it is time to spend." />
            <Card icon={<Cpu className="w-6 h-6" />} title="Pocket Signer hardware"
              text="A USB-C signer with a touch screen. Tap to approve every note and every transaction."
              href="https://pocketsigner.com" />
          </div>
        </div>
      </section>

      {/* Download + install */}
      <section className="border-t border-white/5">
        <div className="max-w-4xl mx-auto px-5 py-16 md:py-20">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-3">Get it</h2>
          <p className="text-gray-400 text-center mb-8">Runs in any browser. On a phone, add it to the home screen.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <LinkRow icon={<Globe className="w-5 h-5" />} title="Web app" sub="nostronchain.com, right here" onClick={onGetStarted} />
            <LinkRow icon={<Smartphone className="w-5 h-5" />} title="Phone" sub="Add to Home Screen on iOS or Android" onClick={onGetStarted} />
            <LinkRow icon={<Download className="w-5 h-5" />} title="Chrome extension" sub="GitHub releases, load unpacked" href={`${GITHUB}/releases`} />
          </div>
          <details className="mt-6 rounded-2xl bg-white/[0.02] border border-white/5 p-5">
            <summary className="cursor-pointer font-semibold text-gray-200">Install the extension</summary>
            <ol className="mt-4 space-y-2 text-gray-300 list-decimal list-inside">
              <li>Download a release from GitHub, or clone the repo and run <code className="text-gray-400">npm install &amp;&amp; npm run build</code>.</li>
              <li>Open <code className="text-gray-400">chrome://extensions</code> and turn on Developer mode.</li>
              <li>Click "Load unpacked" and choose the <code className="text-gray-400">dist/</code> folder.</li>
            </ol>
          </details>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 bg-white/[0.02]">
        <div className="max-w-5xl mx-auto px-5 py-10 flex flex-col md:flex-row items-center justify-between gap-4 text-sm">
          <span className="font-medium text-gray-400">Nostr Onchain</span>
          <p className="text-gray-600 text-center">No tracking. No accounts. Keys stay on your device. Open source.</p>
          <div className="flex items-center gap-5 text-gray-500">
            <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
            <a href="https://nostrtx.com" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">nostrtx.com</a>
            <a href="https://pocketsigner.com" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">pocketsigner.com</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function fmtNum(n: number | null): string {
  return n == null ? '…' : n.toLocaleString();
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-white/15 bg-white/[0.04]' : 'border-white/5 bg-white/[0.02]'}`}>
      <p className="text-2xl font-bold font-mono tabular-nums">{value}</p>
      <p className="text-xs text-gray-400 mt-1">{label}</p>
    </div>
  );
}

function Card({ icon, title, text, href }: { icon: React.ReactNode; title: string; text: string; href?: string }) {
  const body = (
    <div className="h-full p-6 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/15 hover:bg-white/[0.04] transition-all">
      <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-4">{icon}</div>
      <h3 className="font-semibold text-lg mb-2">{title}</h3>
      <p className="text-gray-400">{text}</p>
      {href && <p className="text-sm text-gray-500 mt-3 inline-flex items-center gap-1">pocketsigner.com <ArrowRight className="w-3.5 h-3.5" /></p>}
    </div>
  );
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="block">{body}</a>
    : body;
}

function LinkRow({ icon, title, sub, href, onClick }: { icon: React.ReactNode; title: string; sub: string; href?: string; onClick?: () => void }) {
  const body = (
    <div className="flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/15 hover:bg-white/[0.04] transition-all h-full text-left">
      <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-gray-500">{sub}</p>
      </div>
    </div>
  );
  if (onClick) return <button onClick={onClick} className="block w-full">{body}</button>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className="block">{body}</a>;
}
