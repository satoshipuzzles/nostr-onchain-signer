import { Shield, Zap, Users, FileKey, ArrowRight, Download, Globe, Smartphone, Monitor, Github } from 'lucide-react';

interface Props {
  onGetStarted: () => void;
}

export function Landing({ onGetStarted }: Props) {
  const isExtension = !!globalThis.chrome?.runtime?.id && globalThis.chrome?.runtime?.id !== 'pwa-mode';

  return (
    <div className="h-full overflow-y-auto bg-black text-white">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center">
            <Shield className="w-5 h-5 text-black" />
          </div>
          <span className="font-semibold text-sm">Nostr Onchain</span>
        </div>
        <button
          onClick={onGetStarted}
          className="text-sm px-4 py-2 bg-white text-black rounded-lg font-medium hover:bg-gray-200 transition-colors"
        >
          Launch App
        </button>
      </header>

      {/* Hero */}
      <section className="px-6 py-16 md:py-24 text-center max-w-2xl mx-auto">
        <div className="w-20 h-20 rounded-2xl bg-white flex items-center justify-center mx-auto mb-6 shadow-2xl shadow-white/10">
          <Shield className="w-11 h-11 text-black" />
        </div>
        <h1 className="text-3xl md:text-5xl font-bold mb-4 tracking-tight">
          Social Multi-Sig<br />Bitcoin Signer
        </h1>
        <p className="text-gray-400 text-base md:text-lg max-w-md mx-auto mb-8">
          Create Taproot multi-sig wallets from your Nostr network. 
          Sign Bitcoin transactions and Nostr events from one place.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={onGetStarted}
            className="flex items-center gap-2 px-6 py-3 bg-white text-black rounded-xl font-semibold hover:bg-gray-200 transition-colors"
          >
            Get Started <ArrowRight className="w-4 h-4" />
          </button>
          <a
            href="https://github.com/satoshipuzzles/nostr-onchain-signer"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-6 py-3 border border-white/20 rounded-xl font-medium text-gray-300 hover:bg-white/5 transition-colors"
          >
            <Github className="w-4 h-4" /> View Source
          </a>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 pb-16 max-w-3xl mx-auto">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-6 text-center">How it works</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FeatureCard
            icon={<Users className="w-5 h-5" />}
            title="Social Multi-Sig"
            description="Derive Taproot keys from npubs. Create X-of-N wallets using contacts from your Nostr following list."
          />
          <FeatureCard
            icon={<FileKey className="w-5 h-5" />}
            title="Dual Signer"
            description="NIP-07 Nostr signer + Bitcoin PSBT signing. Works as a Chrome extension and standalone PWA."
          />
          <FeatureCard
            icon={<Zap className="w-5 h-5" />}
            title="On-Chain Invoices"
            description="Request Bitcoin payments via Nostr events (kind 9733). Settle on-chain with OP_RETURN proof."
          />
          <FeatureCard
            icon={<Shield className="w-5 h-5" />}
            title="Coordinated Signing"
            description="Send PSBTs to co-signers via encrypted DMs. Track progress in real-time with threshold alerts."
          />
        </div>
      </section>

      {/* Downloads */}
      <section className="px-6 pb-16 max-w-3xl mx-auto">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-6 text-center">Get Nostr Onchain</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <DownloadCard
            icon={<Globe className="w-5 h-5" />}
            title="Web App"
            subtitle="Use instantly in your browser"
            href="https://nostr-onchain-signer.vercel.app"
            badge="Live"
          />
          <DownloadCard
            icon={<Smartphone className="w-5 h-5" />}
            title="Mobile PWA"
            subtitle="Add to Home Screen on iOS / Android"
            href="https://nostr-onchain-signer.vercel.app"
            badge="Live"
          />
          <DownloadCard
            icon={<Download className="w-5 h-5" />}
            title="Chrome Extension"
            subtitle="Load unpacked from GitHub releases"
            href="https://github.com/satoshipuzzles/nostr-onchain-signer/releases"
            badge="Manual"
          />
          <DownloadCard
            icon={<Monitor className="w-5 h-5" />}
            title="Desktop App"
            subtitle="Electron wrapper (coming soon)"
            badge="Soon"
          />
          <DownloadCard
            icon={<Github className="w-5 h-5" />}
            title="Source Code"
            subtitle="Clone, build, contribute"
            href="https://github.com/satoshipuzzles/nostr-onchain-signer"
            badge="Open Source"
          />
        </div>
      </section>

      {/* How to install extension */}
      <section className="px-6 pb-16 max-w-2xl mx-auto">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-6 text-center">Install Chrome Extension</p>
        <div className="space-y-3">
          <Step number={1} text="Download or clone from GitHub" />
          <Step number={2} text='Run "npm install && npm run build"' />
          <Step number={3} text="Open chrome://extensions → Enable Developer Mode" />
          <Step number={4} text='Click "Load unpacked" → select the dist/ folder' />
        </div>
      </section>

      {/* Tech Stack */}
      <section className="px-6 pb-16 max-w-2xl mx-auto text-center">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-4">Built with</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {['Taproot (BIP-341)', 'Tapscript (BIP-342)', 'PSBT', 'OP_RETURN', 'NIP-07', 'NIP-04', 'Kind 9733', 'Kind 9800-9802', 'React', 'Vite'].map(tag => (
            <span key={tag} className="px-3 py-1 text-xs rounded-full border border-white/10 text-gray-400">
              {tag}
            </span>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 px-6 py-8 text-center">
        <p className="text-xs text-gray-600">
          Nostr Onchain &bull; Open Source &bull; Bitcoin + Nostr
        </p>
        <p className="text-[10px] text-gray-700 mt-2">
          No tracking. No accounts. Keys stay on your device.
        </p>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="p-4 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors">
      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center mb-3 text-white">
        {icon}
      </div>
      <h3 className="font-semibold text-sm mb-1">{title}</h3>
      <p className="text-xs text-gray-500 leading-relaxed">{description}</p>
    </div>
  );
}

function DownloadCard({ icon, title, subtitle, href, badge }: { icon: React.ReactNode; title: string; subtitle: string; href?: string; badge?: string }) {
  const content = (
    <div className="flex items-center gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors">
      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0 text-white">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          {badge && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/10 text-gray-400 uppercase tracking-wider">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 truncate">{subtitle}</p>
      </div>
      {href && <ArrowRight className="w-4 h-4 text-gray-600 flex-shrink-0" />}
    </div>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        {content}
      </a>
    );
  }
  return <div className="opacity-50 cursor-not-allowed">{content}</div>;
}

function Step({ number, text }: { number: number; text: string }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/5">
      <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 text-xs font-bold">
        {number}
      </div>
      <p className="text-sm text-gray-300">{text}</p>
    </div>
  );
}
