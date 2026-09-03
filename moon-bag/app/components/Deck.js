"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Cursor from "./Cursor";
import { SLIDES } from "./slides";
import { EASE_OUT, stageFor } from "./variants";

const pad = (n) => String(n).padStart(2, "0");

const LOCK_MS = 700; // a page turn takes about this long; input is ignored meanwhile
const SETTLE_MS = 150; // wheel silence that separates two gestures
const WHEEL_THRESHOLD = 12; // px of intent: a light nudge turns the page
const NOTCH = 100; // a discrete mouse-wheel notch always counts as a new gesture
const SWIPE = 30; // px of finger travel for a swipe

function Counter({ index, total }) {
  return (
    <div className="flex items-baseline gap-[0.5ch] tabular-nums">
      <span className="relative inline-block overflow-hidden">
        {/* invisible placeholder keeps the baseline and width of the rolling digits */}
        <span className="invisible">00</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={index}
            initial={{ y: "110%" }}
            animate={{ y: 0 }}
            exit={{ y: "-110%" }}
            transition={{ duration: 0.4, ease: EASE_OUT }}
            className="absolute inset-0"
          >
            {pad(index + 1)}
          </motion.span>
        </AnimatePresence>
      </span>
      <span>/ {pad(total)}</span>
    </div>
  );
}

// Scales a slide's content down (never up) so it always fits the stage.
// That is what lets a single nudge turn the page: nothing ever needs to
// scroll inside a slide.
function Fit({ children }) {
  const frameRef = useRef(null);
  const innerRef = useRef(null);
  const [fit, setFit] = useState({ scale: 1, height: "auto" });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const inner = innerRef.current;
    const update = () => {
      const avail = frame.clientHeight;
      const natural = inner.scrollHeight;
      if (natural > avail && avail > 0) {
        const scale = Math.max(0.35, avail / natural);
        setFit({ scale, height: natural * scale });
      } else setFit({ scale: 1, height: "auto" });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(frame);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={frameRef} className="flex h-full w-full flex-col justify-center">
      <div style={{ height: fit.height }}>
        <div
          ref={innerRef}
          style={{ transform: `scale(${fit.scale})`, transformOrigin: "top center" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default function Deck() {
  const total = SLIDES.length;
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const dirRef = useRef(1);
  const stage = useMemo(() => stageFor(() => dirRef.current), []);
  // Gesture state lives in a ref: wheel events fire far too often for setState.
  const g = useRef({ until: 0, armed: true, acc: 0, last: 0, prevAbs: 0, touchY: null, swipedAt: 0 });

  const go = useCallback(
    (n, dir) => {
      const next = Math.max(0, Math.min(total - 1, n));
      if (next === indexRef.current) return false;
      dirRef.current = dir ?? (next > indexRef.current ? 1 : -1);
      indexRef.current = next;
      g.current.until = performance.now() + LOCK_MS;
      setIndex(next);
      return true;
    },
    [total]
  );
  const step = useCallback((dir) => go(indexRef.current + dir, dir), [go]);

  useEffect(() => {
    // Wheel / trackpad: the first nudge turns the page, the momentum tail is
    // ignored, and a new swipe is recognised by a pause or by acceleration.
    const onWheel = (e) => {
      const s = g.current;
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= window.innerHeight;
      const abs = Math.abs(dy);
      if (abs < 1 || abs < Math.abs(e.deltaX)) return;

      const now = performance.now();
      const gap = now - s.last;
      s.last = now;
      const fresh = gap >= SETTLE_MS || abs > s.prevAbs * 1.5 + 4 || abs >= NOTCH;
      s.prevAbs = abs;

      if (now < s.until) return;
      if (!s.armed) {
        if (!fresh) return;
        s.armed = true;
        s.acc = 0;
      }
      if (gap >= SETTLE_MS) s.acc = 0;
      s.acc += dy;
      if (Math.abs(s.acc) < WHEEL_THRESHOLD) return;
      const dir = s.acc > 0 ? 1 : -1;
      s.acc = 0;
      if (step(dir)) s.armed = false;
    };

    const onTouchStart = (e) => {
      g.current.touchY = e.touches[0].clientY;
    };
    const onTouchEnd = (e) => {
      const s = g.current;
      if (s.touchY == null) return;
      const dy = e.changedTouches[0].clientY - s.touchY;
      s.touchY = null;
      if (Math.abs(dy) < SWIPE) return; // a tap: the click handler turns the page
      s.swipedAt = performance.now();
      if (performance.now() < s.until) return;
      step(dy < 0 ? 1 : -1); // finger up = next page
    };

    const onKey = (e) => {
      const tag = e.target?.tagName;
      if ((tag === "BUTTON" || tag === "A") && (e.key === " " || e.key === "Enter")) return;
      if (["ArrowRight", "ArrowDown", " ", "PageDown"].includes(e.key)) {
        e.preventDefault();
        step(1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Home") go(0, -1);
      else if (e.key === "End") go(total - 1, 1);
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("keydown", onKey);
    };
  }, [step, go, total]);

  // A click or tap anywhere turns the page, except on controls and the FAQ.
  const onStageClick = (e) => {
    const s = g.current;
    if (e.target instanceof Element && e.target.closest("button, a, [data-no-advance]")) return;
    if (performance.now() - s.swipedAt < 600) return;
    if (window.getSelection?.()?.toString()) return;
    if (performance.now() < s.until) return;
    step(1);
  };

  // Deep links: #3 opens slide 3; the hash follows navigation.
  useEffect(() => {
    const n = parseInt(window.location.hash.slice(1), 10);
    if (n >= 1 && n <= total) go(n - 1, 1);
  }, [go, total]);

  useEffect(() => {
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", index === 0 ? pathname + search : `#${index + 1}`);
  }, [index]);

  const Slide = SLIDES[index].component;
  const last = index === total - 1;

  return (
    <>
      <Cursor />

      <motion.div
        aria-hidden
        className="fixed left-0 top-0 z-40 h-[2px] bg-black"
        animate={{ width: `${((index + 1) / total) * 100}%` }}
        transition={{ type: "spring", stiffness: 110, damping: 22 }}
      />

      <header className="t-label pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-end px-5 py-5 sm:px-8 sm:py-6">
        <Counter index={index} total={total} />
      </header>

      <main
        onClick={onStageClick}
        className={`relative h-[100svh] w-full overflow-hidden ${last ? "" : "cursor-pointer"}`}
      >
        <AnimatePresence mode="popLayout">
          <motion.section
            key={SLIDES[index].id}
            variants={stage}
            initial="hidden"
            animate="show"
            exit="exit"
            className="h-[100svh] w-full px-5 py-16 sm:px-8 sm:py-20"
          >
            <Fit>
              <Slide onCta={() => step(1)} />
            </Fit>
          </motion.section>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {index === 0 && (
          <motion.div
            key="cue"
            aria-hidden
            className="t-label pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-6 sm:pb-8"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <span>
              scroll <span className="scroll-cue">↓</span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
