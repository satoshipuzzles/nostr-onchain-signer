/** Shared skeleton loaders — shown while relay data loads */

export function SkeletonNote() {
  return (
    <div className="px-4 py-3 flex gap-3 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-white/[0.06] flex-shrink-0" />
      <div className="flex-1 space-y-2 py-0.5">
        <div className="flex gap-2 items-center">
          <div className="h-3 w-24 bg-white/[0.06] rounded" />
          <div className="h-2.5 w-10 bg-white/[0.04] rounded" />
        </div>
        <div className="h-3 w-full bg-white/[0.05] rounded" />
        <div className="h-3 w-3/4 bg-white/[0.05] rounded" />
      </div>
    </div>
  );
}

export function SkeletonFeed({ count = 6 }: { count?: number }) {
  return (
    <div className="divide-y divide-white/5">
      {Array.from({ length: count }, (_, i) => <SkeletonNote key={i} />)}
    </div>
  );
}

export function SkeletonConversation() {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/5 animate-pulse">
      <div className="w-12 h-12 rounded-full bg-white/[0.06] flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="flex justify-between">
          <div className="h-3 w-28 bg-white/[0.06] rounded" />
          <div className="h-2.5 w-8 bg-white/[0.04] rounded" />
        </div>
        <div className="h-2.5 w-40 bg-white/[0.05] rounded" />
      </div>
    </div>
  );
}

export function SkeletonConversationList({ count = 5 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => <SkeletonConversation key={i} />)}
    </div>
  );
}

export function SkeletonWalletCard() {
  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/5 p-4 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-xl bg-white/[0.06]" />
        <div className="space-y-2 flex-1">
          <div className="h-3 w-28 bg-white/[0.06] rounded" />
          <div className="h-2.5 w-20 bg-white/[0.04] rounded" />
        </div>
      </div>
      <div className="h-5 w-32 bg-white/[0.06] rounded" />
    </div>
  );
}

export function SkeletonWalletList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => <SkeletonWalletCard key={i} />)}
    </div>
  );
}
