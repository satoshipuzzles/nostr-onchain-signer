/**
 * A list that holds still while it is being read.
 *
 * Feeds keep changing after they first paint: slow relays answer late, the server-side
 * reader merges in, ranked feeds re-rank when engagement arrives, polls find new notes.
 * Applied straight to the list, each of those shoves the note under the reader's thumb.
 *
 * useSteadyList takes the list a feed wants to show and gives back the list to render:
 *
 *  - at the top of the feed, the two are the same;
 *  - once the reader has scrolled down, what is already rendered keeps its place and
 *    order. Notes that belong further down are added below. Notes that belong above
 *    ("newest" mode) wait, counted in `held`, behind the sticky pill; in "ranked" mode
 *    they join below what was rendered, so nothing is hidden and no pill is needed;
 *  - release() (the pill) or scrolling back to the top lets the waiting notes in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';

/** How far the top of the list must be above the viewport before the reader counts as reading. */
const READING_PX = 160;

export type SteadyMode = 'newest' | 'ranked';

export function steadyMerge<T>(prev: T[], incoming: T[], idOf: (t: T) => string, rendered: number, mode: SteadyMode): { next: T[]; held: number } {
  if (!prev.length) return { next: incoming, held: 0 };
  const index = new Map<string, number>();
  incoming.forEach((x, i) => index.set(idOf(x), i));
  // what is on screen keeps its order (dropping anything the feed no longer has, e.g. a muted author)
  const frozen: T[] = [];
  const frozenIds = new Set<string>();
  for (const x of prev.slice(0, rendered)) {
    const i = index.get(idOf(x));
    if (i === undefined) continue;
    frozen.push(incoming[i]);
    frozenIds.add(idOf(x));
  }
  if (!frozen.length) return { next: incoming, held: 0 };
  const rest = incoming.filter((x) => !frozenIds.has(idOf(x)));
  if (mode === 'ranked') return { next: [...frozen, ...rest], held: 0 };
  const last = index.get(idOf(frozen[frozen.length - 1]))!;
  const below = rest.filter((x) => index.get(idOf(x))! > last);
  return { next: [...frozen, ...below], held: rest.length - below.length };
}

export interface Steady<T> {
  list: T[];
  /** notes waiting above the reader */
  held: number;
  /** show the waiting notes and go to the top */
  release: () => void;
  /** put this at the very top of the list */
  anchorRef: React.RefObject<HTMLDivElement>;
}

export function useSteadyList<T>(
  incoming: T[],
  idOf: (t: T) => string,
  opts: { resetKey: string; mode: SteadyMode; rendered?: number },
): Steady<T> {
  const { resetKey, mode } = opts;
  const rendered = opts.rendered ?? Infinity;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ list: T[]; held: number }>({ list: incoming, held: 0 });
  const shownRef = useRef<T[]>(incoming);
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  const keyRef = useRef(resetKey);
  const openUntilRef = useRef(0); // after release(), updates flow freely while the page scrolls up
  const heldRef = useRef(0);

  const reading = useCallback(() => {
    const el = anchorRef.current;
    return !!el && el.getBoundingClientRect().top < -READING_PX;
  }, []);

  const apply = useCallback((list: T[], held: number) => {
    shownRef.current = list;
    heldRef.current = held;
    setState((s) => (s.list === list && s.held === held ? s : { list, held }));
  }, []);

  useEffect(() => {
    const fresh = keyRef.current !== resetKey;
    keyRef.current = resetKey;
    if (fresh || Date.now() < openUntilRef.current || !reading()) { apply(incoming, 0); return; }
    const { next, held } = steadyMerge(shownRef.current, incoming, idOf, renderedRef.current, mode);
    apply(next, held);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, resetKey, mode]);

  // back at the top by hand: let the waiting notes in
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf || !heldRef.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (heldRef.current && !reading()) apply(incomingRef.current, 0);
      });
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener('scroll', onScroll, { capture: true }); if (raf) cancelAnimationFrame(raf); };
  }, [apply, reading]);

  const release = useCallback(() => {
    openUntilRef.current = Date.now() + 1500;
    apply(incomingRef.current, 0);
    anchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [apply]);

  // a different feed shows at once; otherwise the render that receives a new list still shows
  // the steady one, and the effect above decides what may change
  const switched = keyRef.current !== resetKey;
  return { list: switched ? incoming : state.list, held: switched ? 0 : state.held, release, anchorRef };
}

/** The sticky "N new notes" pill. Takes no room in the page, so showing it moves nothing. */
export function NewNotesPill({ count, onClick, label }: { count: number; onClick: () => void; label?: string }) {
  if (count <= 0) return null;
  return (
    <div className="sticky top-[60px] z-10 h-0 flex justify-center pointer-events-none" data-testid="new-notes-pill">
      <button
        onClick={onClick}
        className="pointer-events-auto self-start mt-2 flex items-center gap-1.5 px-4 py-2 rounded-full bg-purple-600 text-white text-[13px] font-semibold shadow-lg shadow-purple-500/30 hover:bg-purple-500 transition-colors whitespace-nowrap"
      >
        <ArrowUp className="w-3.5 h-3.5" />
        {label ?? `${count} new ${count === 1 ? 'note' : 'notes'}`}
      </button>
    </div>
  );
}
