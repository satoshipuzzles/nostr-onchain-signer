import { toast } from 'sonner';
import { publishEvent, formatPublishResult, type PublishResult } from '@/lib/nostr/publish';

import { celebrate } from './celebrations';

const host = (u: string) => u.replace(/^wss?:\/\//, '').replace(/\/$/, '');

/** Kept for callers that celebrate something other than a publish (signing). */
export function fireConfetti(_durationMs?: number): void {
  void celebrate();
}

const TOAST_STYLE = {
  background: 'linear-gradient(135deg, #1e1033 0%, #14141f 100%)',
  border: '1px solid rgba(168, 85, 247, 0.45)',
  color: '#fff',
  fontSize: '14px',
  fontWeight: '600',
  borderRadius: '16px',
  boxShadow: '0 12px 40px rgba(124, 58, 237, 0.35)',
  padding: '14px 16px',
};

export function celebratePublish(message = 'Published!', description?: string, id?: string | number): void {
  toast.success(message, { id, description, duration: 3500, style: TOAST_STYLE });
  void celebrate();
}

export async function publishWithFeedback(
  event: Parameters<typeof publishEvent>[0],
  successMessage = 'Published!',
): Promise<PublishResult> {
  const t0 = performance.now();
  const toastId = `pub-${event.id ?? Date.now()}`;
  let tally = '';
  let shown = false;
  // Answer as soon as the first relay has it; the tally fills in when the rest reply
  const result = await publishEvent(event, {
    resolveAfter: 1,
    onSettled: (r) => {
      if (!r.success.length) return;
      tally = `Live on ${r.success.length} of ${r.success.length + r.failed.length} relays`;
      if (!shown) return;  // the celebration below will show it
      toast.success(successMessage, {
        id: toastId,
        description: `Live on ${r.success.length} of ${r.success.length + r.failed.length} relays`,
        duration: 3000,
        style: TOAST_STYLE,
      });
    },
  });
  if (result.success.length === 0) {
    toast.error(formatPublishResult(result), {
      duration: 5000,
      style: {
        background: '#1a1a2e',
        border: '1px solid rgba(239, 68, 68, 0.3)',
        color: '#fff',
        fontSize: '13px',
        borderRadius: '12px',
      },
    });
    throw new Error(formatPublishResult(result));
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  shown = true;
  celebratePublish(successMessage, tally ? `${tally} · ${secs}s` : `Live on ${host(result.success[0])} · ${secs}s · more relays confirming…`, toastId);
  return result;
}
