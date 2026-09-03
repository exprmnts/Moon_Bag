// Shared motion variants. Every slide is a "stage" whose children are "line"s.
export const EASE_OUT = [0.22, 1, 0.36, 1];
export const EASE_IN = [0.4, 0, 1, 1];

const DIST = 90;

// Slide-level transition, read at animation time so an exiting slide always
// uses the latest direction: +1 = next (page rises from below), -1 = back.
export const stageFor = (getDir) => ({
  hidden: () => ({ opacity: 0, y: getDir() * DIST }),
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.75,
      ease: EASE_OUT,
      staggerChildren: 0.06,
      delayChildren: 0.1,
    },
  },
  exit: () => ({
    opacity: 0,
    y: -getDir() * DIST,
    transition: { duration: 0.4, ease: EASE_IN },
  }),
});

// A nested orchestrator with its own stagger (used for word-by-word reveals).
export const group = (stagger = 0.06) => ({
  hidden: {},
  show: { transition: { staggerChildren: stagger } },
});

export const line = {
  hidden: { opacity: 0, y: 18, filter: "blur(6px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.7, ease: EASE_OUT },
  },
};
