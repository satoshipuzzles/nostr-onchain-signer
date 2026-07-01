import { Shield, Zap, Users, FileKey, ArrowRight, Download, Globe, Smartphone, Monitor, Github, Lock, Radio } from 'lucide-react';

interface Props {
  onGetStarted: () => void;
}

export function Landing({ onGetStarted }: Props) {
  return (
    <div className="h-full overflow-y-auto bg-black text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-black/80 border-b border-white/5">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white text-black flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <span className="font-bold text-base">Nostr Onchain</span>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/satoshipuzzles/nostr-onchain-signer"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              <Github className="w-4 h-4" /> GitHub
            </a>
            <button
              onClick={onGetStarted}
              className="text-sm px-5 py-2.5 bg-white text-black rounded-xl font-semibold hover:bg-gray-100 transition-colors"
            >
              Launch App
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.03)_0%,transparent_60%)]" />
        <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-36 text-center">
          <div className="w-20 h-20 md:w-24 md:h-24 rounded-3xl bg-white text-black flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-white/5">
            <Shield className="w-11 h-11 md:w-14 md:h-14" />
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold mb-6 tracking-tight leading-[1.1]">
            Social Multi-Sig<br />
            <span className="text-gray-400">Bitcoin Signer</span>
          </h1>
          <p className="text-gray-400 text-lg md:text-xl max-w-xl mx-auto mb-10 leading-relaxed">
            Create Taproot multi-sig wallets from your Nostr network. 
            Sign Bitcoin transactions and Nostr events from one unified tool.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={onGetStarted}
              className="flex items-center gap-2 px-8 py-4 bg-white text-black rounded-2xl font-semibold text-base hover:bg-gray-100 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              Get Started <ArrowRight className="w-5 h-5" />
            </button>
            <a
              href="https://github.com/satoshipuzzles/nostr-onchain-signer"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-8 py-4 border border-white/20 rounded-2xl font-medium text-gray-300 hover:bg-white/5 transition-all"
            >
              <Github className="w-5 h-5" /> View Source
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-white/5 bg-white/[0.01]">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <p className="text-xs text-gray-500 uppercase tracking-[0.2em] mb-3 text-center">Features</p>
          <h2 className="text-2xl md:text-4xl font-bold text-center mb-12">Everything in one place</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <FeatureCard
              icon={<Users className="w-6 h-6" />}
              title="Social Multi-Sig"
              description="Derive Taproot keys from npubs. Create X-of-N wallets using contacts from your Nostr following list."
            />
            <FeatureCard
              icon={<FileKey className="w-6 h-6" />}
              title="Dual Signer"
              description="NIP-07 Nostr signer + Bitcoin PSBT signing. Works as a Chrome extension and standalone PWA."
            />
            <FeatureCard
              icon={<Zap className="w-6 h-6" />}
              title="On-Chain Invoices"
              description="Request Bitcoin payments via Nostr events (kind 9733). Settle on-chain with OP_RETURN proof."
            />
            <FeatureCard
              icon={<Radio className="w-6 h-6" />}
              title="Coordinated Signing"
              description="Send PSBTs to co-signers via encrypted DMs. Track progress in real-time with threshold alerts."
            />
          </div>
        </div>
      </section>

      {/* Downloads */}
      <section className="border-t border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <p className="text-xs text-gray-500 uppercase tracking-[0.2em] mb-3 text-center">Download</p>
          <h2 className="text-2xl md:text-4xl font-bold text-center mb-4">Get Nostr Onchain</h2>
          <p className="text-gray-500 text-center mb-12 max-w-lg mx-auto">
            Available on every platform. Use on desktop with the Chrome extension or on mobile as a PWA.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
            <DownloadCard
              icon={<Globe className="w-6 h-6" />}
              title="Web App"
              subtitle="Use instantly in your browser"
              href="https://nostr-onchain-signer.vercel.app"
              badge="Live"
            />
            <DownloadCard
              icon={<Smartphone className="w-6 h-6" />}
              title="Mobile PWA"
              subtitle="Add to Home Screen on iOS / Android"
              href="https://nostr-onchain-signer.vercel.app"
              badge="Live"
            />
            <DownloadCard
              icon={<Download className="w-6 h-6" />}
              title="Chrome Extension"
              subtitle="Load unpacked from GitHub releases"
              href="https://github.com/satoshipuzzles/nostr-onchain-signer/releases"
              badge="Manual Install"
            />
            <DownloadCard
              icon={<Monitor className="w-6 h-6" />}
              title="Desktop App"
              subtitle="Electron wrapper coming soon"
              badge="Coming Soon"
            />
            <DownloadCard
              icon={<Github className="w-6 h-6" />}
              title="Source Code"
              subtitle="Clone, build, contribute — MIT license"
              href="https://github.com/satoshipuzzles/nostr-onchain-signer"
              badge="Open Source"
            />
            <DownloadCard
              icon={<Lock className="w-6 h-6" />}
              title="NIP-07 Login"
              subtitle="Use any existing Nostr extension"
              onClick={onGetStarted}
              badge="Desktop"
            />
          </div>
        </div>
      </section>

      {/* Install Guide */}
      <section className="border-t border-white/5 bg-white/[0.01]">
        <div className="max-w-4xl mx-auto px-6 py-20 md:py-28">
          <p className="text-xs text-gray-500 uppercase tracking-[0.2em] mb-3 text-center">Setup</p>
          <h2 className="text-2xl md:text-4xl font-bold text-center mb-12">Install Chrome Extension</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Step number={1} text="Download or clone the repository from GitHub" />
            <Step number={2} text="Run npm install && npm run build in terminal" />
            <Step number={3} text="Open chrome://extensions and enable Developer Mode" />
            <Step number={4} text='Click "Load unpacked" and select the dist/ folder' />
          </div>
        </div>
      </section>

      {/* Tech Stack */}
      <section className="border-t border-white/5">
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <p className="text-xs text-gray-500 uppercase tracking-[0.2em] mb-6">Built with</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {['Taproot (BIP-341)', 'Tapscript (BIP-342)', 'PSBT', 'OP_RETURN', 'NIP-07', 'NIP-04', 'Kind 9733', 'Kind 9800-9802', 'secp256k1', 'React', 'Vite', 'TypeScript'].map(tag => (
              <span key={tag} className="px-4 py-1.5 text-xs rounded-full border border-white/10 text-gray-400 hover:border-white/20 transition-colors">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 bg-white/[0.02]">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-white text-black flex items-center justify-center">
              <Shield className="w-4 h-4" />
            </div>
            <span className="text-sm font-medium text-gray-400">Nostr Onchain</span>
          </div>
          <p className="text-xs text-gray-600 text-center">
            No tracking &bull; No accounts &bull; Keys stay on your device &bull; Open source
          </p>
          <a
            href="https://github.com/satoshipuzzles/nostr-onchain-signer"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            github.com/satoshipuzzles
          </a>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/15 transition-all hover:bg-white/[0.04] group">
      <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-4 text-white group-hover:bg-white/10 transition-colors">
        {icon}
      </div>
      <h3 className="font-semibold text-base mb-2">{title}</h3>
      <p className="text-sm text-gray-500 leading-relaxed">{description}</p>
    </div>
  );
}

function DownloadCard({ icon, title, subtitle, href, badge, onClick }: { icon: React.ReactNode; title: string; subtitle: string; href?: string; badge?: string; onClick?: () => void }) {
  const content = (
    <div className="flex items-center gap-4 p-5 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/15 transition-all hover:bg-white/[0.04] h-full">
      <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0 text-white">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-semibold">{title}</p>
          {badge && (
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/10 text-gray-400 uppercase tracking-wider font-medium">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">{subtitle}</p>
      </div>
      <ArrowRight className="w-4 h-4 text-gray-600 flex-shrink-0" />
    </div>
  );

  if (onClick) {
    return <button onClick={onClick} className="block w-full text-left">{content}</button>;
  }
  if (href) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className="block">{content}</a>;
  }
  return <div className="opacity-50 cursor-not-allowed">{content}</div>;
}

function Step({ number, text }: { number: number; text: string }) {
  return (
    <div className="flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] border border-white/5">
      <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 text-sm font-bold text-white">
        {number}
      </div>
      <p className="text-sm text-gray-300">{text}</p>
    </div>
  );
}
