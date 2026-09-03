"use client";
import { motion } from "motion/react";
import { EASE_OUT, line } from "./variants";

// "Trench Experience vs 10000x Tokens" — redrawn from the deck, in black only.
// Plot area: x 60→500 (2021→2025), y 300→30 (0.0→3.0).
const X = { 2021: 60, 2022: 170, 2023: 280, 2024: 390, 2025: 500 };
const yOf = (v) => 300 - (v / 3) * 270;
const YTICKS = [0, 0.5, 1, 1.5, 2, 2.5, 3];
const POINTS = [
  [X[2021], yOf(0)],
  [X[2022], yOf(0)],
  [X[2023], yOf(1)],
  [X[2024], yOf(2)],
  [X[2025], yOf(3)],
];
const PATH =
  "M 60 300 C 95 304, 135 305, 170 299 C 215 290, 250 232, 280 210 C 315 185, 355 148, 390 120 C 425 92, 465 60, 500 30";

// Inherit hidden/show from the slide, so the chart draws itself on scroll-in.
const draw = {
  hidden: { pathLength: 0 },
  show: { pathLength: 1, transition: { duration: 1.8, ease: EASE_OUT, delay: 0.5 } },
};
const dot = (i) => ({
  hidden: { scale: 0, opacity: 0 },
  show: {
    scale: 1,
    opacity: 1,
    transition: { delay: 0.6 + i * 0.35, duration: 0.35, ease: EASE_OUT },
  },
});
const caption = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { delay: 2.4, duration: 0.6 } },
};

export default function Chart() {
  return (
    <motion.figure variants={line} className="w-full">
      <svg
        viewBox="0 0 520 370"
        className="h-auto w-full"
        role="img"
        aria-label="Trench Experience vs 10000x Tokens"
      >
        <text
          x="60"
          y="12"
          className="fill-black font-serif"
          fontSize="16"
          fontStyle="italic"
        >
          Trench Experience vs 10000x Tokens
        </text>

        {YTICKS.map((t) => (
          <g key={t}>
            <line
              x1="60"
              x2="500"
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="#000"
              strokeWidth={t === 0 ? 1 : 0.5}
              strokeDasharray={t === 0 ? undefined : "2 6"}
            />
            <text
              x="48"
              y={yOf(t) + 3.5}
              textAnchor="end"
              className="fill-black font-mono"
              fontSize="10"
            >
              {t.toFixed(1)}
            </text>
          </g>
        ))}

        {Object.entries(X).map(([year, x]) => (
          <text
            key={year}
            x={x}
            y="322"
            textAnchor="middle"
            className="fill-black font-mono"
            fontSize="10"
          >
            {year}
          </text>
        ))}

        <motion.path
          d={PATH}
          fill="none"
          stroke="#000"
          strokeWidth="2.5"
          strokeLinecap="round"
          variants={draw}
        />

        {POINTS.map(([cx, cy], i) => (
          <motion.circle
            key={i}
            cx={cx}
            cy={cy}
            r="4"
            fill="#000"
            variants={dot(i)}
            style={{ transformBox: "fill-box", transformOrigin: "center" }}
          />
        ))}

        <motion.text
          x="280"
          y="352"
          textAnchor="middle"
          className="fill-black font-mono"
          fontSize="10"
          variants={caption}
        >
          made it up
        </motion.text>
      </svg>
    </motion.figure>
  );
}
