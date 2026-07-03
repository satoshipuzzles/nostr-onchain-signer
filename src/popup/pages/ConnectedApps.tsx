import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Globe, Trash2, ChevronDown, ChevronUp, Shield, ShieldAlert, ShieldOff } from 'lucide-react';

interface ConnectedApp {
  origin: string;
  name?: string;
  firstUsed: number;
  lastUsed: number;
  signCount: number;
  permission: 'always' | 'ask' | 'deny';
  allowedKinds?: number[];
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

const PERMISSION_CONFIG = {
  always: { label: 'Always', icon: Shield, color: 'text-green-400', bg: 'bg-green-400/10' },
  ask: { label: 'Ask', icon: ShieldAlert, color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  deny: { label: 'Deny', icon: ShieldOff, color: 'text-red-400', bg: 'bg-red-400/10' },
} as const;

export function ConnectedApps() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [expandedOrigin, setExpandedOrigin] = useState<string | null>(null);
  const [kindsInput, setKindsInput] = useState('');

  const loadApps = useCallback(async () => {
    const data = await chrome.storage.local.get('connected_apps');
    const list = (data.connected_apps as ConnectedApp[]) || [];
    list.sort((a, b) => b.lastUsed - a.lastUsed);
    setApps(list);
  }, []);

  useEffect(() => { loadApps(); }, [loadApps]);

  async function saveApps(updated: ConnectedApp[]) {
    await chrome.storage.local.set({ connected_apps: updated });
    setApps([...updated].sort((a, b) => b.lastUsed - a.lastUsed));
  }

  async function clearAll() {
    await chrome.storage.local.remove('connected_apps');
    setApps([]);
    setExpandedOrigin(null);
  }

  function updatePermission(origin: string, permission: ConnectedApp['permission']) {
    const updated = apps.map(a => a.origin === origin ? { ...a, permission } : a);
    saveApps(updated);
  }

  function updateAllowedKinds(origin: string, kinds: number[] | undefined) {
    const updated = apps.map(a => a.origin === origin ? { ...a, allowedKinds: kinds } : a);
    saveApps(updated);
  }

  function removeApp(origin: string) {
    const updated = apps.filter(a => a.origin !== origin);
    saveApps(updated);
    if (expandedOrigin === origin) setExpandedOrigin(null);
  }

  function handleExpand(origin: string, currentKinds?: number[]) {
    if (expandedOrigin === origin) {
      setExpandedOrigin(null);
    } else {
      setExpandedOrigin(origin);
      setKindsInput(currentKinds?.join(', ') ?? '');
    }
  }

  function handleKindsSave(origin: string) {
    const trimmed = kindsInput.trim();
    if (!trimmed) {
      updateAllowedKinds(origin, undefined);
    } else {
      const kinds = trimmed.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      updateAllowedKinds(origin, kinds.length > 0 ? kinds : undefined);
    }
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 overflow-y-auto pb-24">
      <div className="flex items-center gap-3 mb-5">
        <button onClick={() => navigate('/settings')} className="text-gray-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold flex-1">Connected Apps</h1>
        {apps.length > 0 && (
          <button onClick={clearAll} className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" />
            Clear All
          </button>
        )}
      </div>

      {apps.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <Globe className="w-12 h-12 text-gray-600 mb-3" />
          <p className="text-sm text-gray-400">No connected apps yet</p>
          <p className="text-xs text-gray-600 mt-1">
            Apps will appear here when they use NIP-07 signing through this extension.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {apps.map(app => {
            const perm = PERMISSION_CONFIG[app.permission];
            const PermIcon = perm.icon;
            const isExpanded = expandedOrigin === app.origin;

            return (
              <div key={app.origin} className="card">
                <button
                  onClick={() => handleExpand(app.origin, app.allowedKinds)}
                  className="w-full flex items-center gap-3 text-left"
                >
                  <Globe className="w-8 h-8 text-gray-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{app.name || app.origin}</p>
                    <p className="text-xs text-gray-500 truncate">{app.origin}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] text-gray-500">{app.signCount} sign{app.signCount !== 1 ? 's' : ''}</span>
                      <span className="text-[10px] text-gray-600">{relativeTime(app.lastUsed)}</span>
                    </div>
                  </div>
                  <span className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${perm.bg} ${perm.color}`}>
                    <PermIcon className="w-3 h-3" />
                    {perm.label}
                  </span>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                </button>

                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-surface-200/10 space-y-3">
                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Permission</p>
                      <div className="flex gap-2">
                        {(['always', 'ask', 'deny'] as const).map(p => {
                          const cfg = PERMISSION_CONFIG[p];
                          const Icon = cfg.icon;
                          return (
                            <button
                              key={p}
                              onClick={() => updatePermission(app.origin, p)}
                              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                                app.permission === p
                                  ? `${cfg.bg} ${cfg.color} ring-1 ring-current`
                                  : 'bg-surface-700/50 text-gray-500 hover:text-gray-300'
                              }`}
                            >
                              <Icon className="w-3.5 h-3.5" />
                              {cfg.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Allowed Kinds (optional)</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={kindsInput}
                          onChange={e => setKindsInput(e.target.value)}
                          placeholder="e.g. 1, 7, 9733"
                          className="flex-1 bg-surface-700/50 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30"
                        />
                        <button
                          onClick={() => handleKindsSave(app.origin)}
                          className="px-3 py-2 bg-bitcoin text-white rounded-lg text-xs font-medium hover:bg-bitcoin/90 transition-colors"
                        >
                          Save
                        </button>
                      </div>
                      <p className="text-[10px] text-gray-600 mt-1">
                        Leave empty to allow all kinds. Comma-separated list of event kinds.
                      </p>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-gray-600">
                      <span>First used: {new Date(app.firstUsed).toLocaleDateString()}</span>
                      <button
                        onClick={() => removeApp(app.origin)}
                        className="text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
