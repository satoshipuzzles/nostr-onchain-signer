import { useEffect, useRef, useState } from 'react';
import { X, ImageUp, Loader2 } from 'lucide-react';

/**
 * Full-screen camera scanner for payment QR codes.
 *
 * Uses the browser's BarcodeDetector where it exists (Chrome, Android) and
 * falls back to jsQR on a canvas everywhere else (iOS Safari, Firefox). jsQR is
 * loaded only when the scanner opens. If the camera is unavailable — denied,
 * no camera, or the extension popup — a photo of the code works instead.
 */
interface Props {
  onResult: (text: string) => void;
  onClose: () => void;
}

type Decoder = (source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap, w: number, h: number) => Promise<string | null>;

async function makeDecoder(canvas: HTMLCanvasElement): Promise<Decoder> {
  const BD = (window as any).BarcodeDetector;
  if (BD) {
    try {
      const formats: string[] = await BD.getSupportedFormats?.() ?? ['qr_code'];
      if (formats.includes('qr_code')) {
        const det = new BD({ formats: ['qr_code'] });
        return async (src) => {
          const codes = await det.detect(src);
          return codes[0]?.rawValue ?? null;
        };
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  const jsQR = (await import('jsqr')).default;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return async (src, w, h) => {
    if (!w || !h) return null;
    // Scale large frames down; jsQR is quick at ~640px and slow at 4K.
    const scale = Math.min(1, 800 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(src as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  };
}

export function QrScanner({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const decoderRef = useRef<Decoder | null>(null);
  const doneRef = useRef(false);
  const [status, setStatus] = useState<'starting' | 'scanning' | 'nocamera'>('starting');
  const [error, setError] = useState('');

  function finish(text: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    navigator.vibrate?.(40);
    onResult(text);
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let busy = false;
    let cancelled = false;

    (async () => {
      decoderRef.current = await makeDecoder(canvasRef.current!);
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('nocamera');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e: any) {
        if (cancelled) return;
        setStatus('nocamera');
        setError(e?.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'No camera available.');
        return;
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus('scanning');

      const tick = async () => {
        if (cancelled || doneRef.current) return;
        if (!busy && video.readyState >= 2) {
          busy = true;
          try {
            const text = await decoderRef.current!(video, video.videoWidth, video.videoHeight);
            if (text) { finish(text); return; }
          } catch {
            /* a bad frame; keep going */
          }
          busy = false;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      const bmp = await createImageBitmap(file);
      if (!decoderRef.current) decoderRef.current = await makeDecoder(canvasRef.current!);
      const text = await decoderRef.current(bmp, bmp.width, bmp.height);
      if (text) finish(text);
      else setError('No QR code found in that image.');
    } catch {
      setError('Could not read that image.');
    }
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col" role="dialog" aria-label="Scan QR code">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-sm font-medium">Scan address</span>
        <button type="button" onClick={onClose} className="p-2 -mr-2 rounded-full hover:bg-white/10" aria-label="Close">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        <video ref={videoRef} playsInline muted className={`absolute inset-0 w-full h-full object-cover ${status === 'scanning' ? '' : 'hidden'}`} />
        {status === 'scanning' && (
          <div className="relative w-64 h-64 max-w-[75vw] max-h-[75vw] rounded-2xl border-2 border-bitcoin shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
        )}
        {status === 'starting' && <Loader2 className="w-8 h-8 animate-spin text-gray-400" />}
        {status === 'nocamera' && (
          <div className="px-6 text-center text-gray-300 text-sm">
            <p>Camera is not available here.</p>
            <p className="text-xs text-gray-500 mt-1">Choose a photo or screenshot of the QR code instead.</p>
          </div>
        )}
      </div>

      <div className="px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-2">
        {error && <p className="text-xs text-red-400 text-center">{error}</p>}
        {status === 'scanning' && (
          <p className="text-xs text-gray-400 text-center">Point the camera at a Bitcoin address or payment QR code.</p>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full py-3 rounded-xl bg-white/10 text-white text-sm flex items-center justify-center gap-2"
        >
          <ImageUp className="w-4 h-4" /> Choose photo
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
