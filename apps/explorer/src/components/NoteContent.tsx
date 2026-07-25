const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i;
const URL_RE = /(https?:\/\/[^\s]+)/g;

/** Minimal note renderer: paragraphs, links, inline images. */
export function NoteContent({ content }: { content: string }) {
  const parts = content.split(URL_RE);
  return (
    <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((part, i) => {
        if (!part.startsWith('http')) return <span key={i}>{part}</span>;
        if (IMAGE_RE.test(part)) {
          return <img key={i} src={part} alt="" className="rounded-xl max-h-96 my-2 border border-zinc-800" loading="lazy" />;
        }
        return (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="text-nostr hover:underline break-all">
            {part}
          </a>
        );
      })}
    </div>
  );
}
