"use client";
import { useEffect, useState } from "react";
import { motion, useMotionValue, useSpring } from "motion/react";

// A small pencil that follows the pointer, tip on the hotspot, eraser up.
// Tilts a little over anything clickable and presses in on click.
function Pencil() {
  return (
    <svg
      data-cursor-pencil
      viewBox="0 0 24 96"
      width="11"
      height="44"
      fill="none"
      stroke="#000"
      strokeWidth="2"
      strokeLinejoin="round"
      style={{ position: "absolute", left: -5.5, top: -44 }}
    >
      <rect x="5" y="1" width="14" height="12" rx="3" fill="#fff" />
      <rect x="5" y="13" width="14" height="9" fill="#000" />
      <line x1="5" y1="16" x2="19" y2="16" stroke="#fff" strokeWidth="1" />
      <line x1="5" y1="19" x2="19" y2="19" stroke="#fff" strokeWidth="1" />
      <rect x="5" y="22" width="14" height="50" fill="#fff" />
      <line x1="12" y1="22" x2="12" y2="72" strokeWidth="1.5" />
      <polygon points="5,72 19,72 12,95" fill="#fff" />
      <polygon points="9.5,87 14.5,87 12,95" fill="#000" stroke="none" />
    </svg>
  );
}

export default function Cursor() {
  const [enabled, setEnabled] = useState(false);
  const [hot, setHot] = useState(false);
  const [down, setDown] = useState(false);
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  // Tight spring: the pencil feels attached to the hand, not trailing it.
  const sx = useSpring(x, { stiffness: 1200, damping: 70, mass: 0.3 });
  const sy = useSpring(y, { stiffness: 1200, damping: 70, mass: 0.3 });

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    setEnabled(true);
    document.documentElement.classList.add("has-cursor");

    const move = (e) => {
      x.set(e.clientX);
      y.set(e.clientY);
    };
    const over = (e) => {
      const el = e.target instanceof Element ? e.target : null;
      setHot(!!el?.closest("button, a, [data-cursor]"));
    };
    const press = () => setDown(true);
    const release = () => setDown(false);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });
    window.addEventListener("pointerdown", press, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      document.documentElement.classList.remove("has-cursor");
    };
  }, [x, y]);

  if (!enabled) return null;

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[100]"
      style={{ x: sx, y: sy }}
    >
      {/* Rotates around (0,0), which is where the pencil tip sits. */}
      <motion.div
        className="absolute left-0 top-0"
        style={{ originX: 0, originY: 0 }}
        animate={{ rotate: hot ? 28 : 45, scale: down ? 0.9 : hot ? 1.12 : 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 28 }}
      >
        <Pencil />
      </motion.div>
    </motion.div>
  );
}
