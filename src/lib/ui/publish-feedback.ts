import { toast } from 'sonner';
import { publishEvent, formatPublishResult, type PublishResult } from '@/lib/nostr/publish';

const CONFETTI_COLORS = ['#a855f7', '#7c3aed', '#f7931a', '#22c55e', '#3b82f6', '#ec4899', '#eab308'];

export function fireConfetti(durationMs = 2500): void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:99999';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }
  const context = ctx;

  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  resize();
  window.addEventListener('resize', resize);

  const particles = Array.from({ length: 120 }, () => ({
    x: canvas.width * 0.5 + (Math.random() - 0.5) * canvas.width * 0.6,
    y: canvas.height * 0.4,
    w: 5 + Math.random() * 7,
    h: 8 + Math.random() * 10,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    rotation: Math.random() * 360,
    spin: (Math.random() - 0.5) * 14,
    vx: (Math.random() - 0.5) * 12,
    vy: -8 - Math.random() * 12,
    opacity: 1,
  }));

  const start = performance.now();

  function frame(now: number) {
    const elapsed = now - start;
    const progress = elapsed / durationMs;
    context.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.vx *= 0.99;
      p.rotation += p.spin;
      p.opacity = Math.max(0, 1 - progress * 0.8);

      context.save();
      context.globalAlpha = p.opacity;
      context.translate(p.x, p.y);
      context.rotate((p.rotation * Math.PI) / 180);
      context.fillStyle = p.color;
      context.beginPath();
      context.roundRect(-p.w / 2, -p.h / 2, p.w, p.h, 2);
      context.fill();
      context.restore();
    }

    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', resize);
      canvas.remove();
    }
  }

  requestAnimationFrame(frame);
}

export function celebratePublish(message = 'Published!'): void {
  toast.success(message, {
    duration: 3000,
    style: {
      background: '#1a1a2e',
      border: '1px solid rgba(168, 85, 247, 0.3)',
      color: '#fff',
      fontSize: '13px',
      fontWeight: '500',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(124, 58, 237, 0.2)',
    },
  });
  fireConfetti();
}

export async function publishWithFeedback(
  event: Parameters<typeof publishEvent>[0],
  successMessage = 'Published!',
): Promise<PublishResult> {
  const result = await publishEvent(event);
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
  if (result.failed.length > 0) {
    toast.warning(formatPublishResult(result), {
      duration: 4000,
      style: {
        background: '#1a1a2e',
        border: '1px solid rgba(234, 179, 8, 0.3)',
        color: '#fff',
        fontSize: '13px',
        borderRadius: '12px',
      },
    });
  } else {
    celebratePublish(successMessage);
  }
  return result;
}
