import { useEffect, useRef } from 'react';
import QrCreator from 'qr-creator';

interface Props {
  data: string;
  size?: number;
  className?: string;
}

/** Locally-rendered QR code (no external API, works offline). */
export function QRCode({ data, size = 160, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '';
    QrCreator.render(
      {
        text: data,
        radius: 0.35,
        ecLevel: 'M',
        fill: '#111111',
        background: '#ffffff',
        size: size * 2, // 2x for retina sharpness
      },
      ref.current,
    );
    const canvas = ref.current.querySelector('canvas');
    if (canvas) {
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    }
  }, [data, size]);

  return (
    <div
      ref={ref}
      className={`bg-white rounded-lg p-2 inline-flex items-center justify-center ${className}`}
      style={{ width: size + 16, height: size + 16 }}
    />
  );
}
