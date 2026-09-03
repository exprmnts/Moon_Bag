"use client";

// The deck literally says "[Button]" — so the button is a pair of brackets.
// Idle: brackets breathe. Hover: brackets spread, black fill slides in.
export default function BracketButton({ children, onClick }) {
  return (
    <button
      type="button"
      data-cursor
      onClick={() => onClick?.()}
      className="group relative ml-[0.2em] inline-flex items-baseline whitespace-nowrap align-baseline leading-none transition-transform duration-200 active:scale-95"
    >
      <span
        aria-hidden
        className="bracket-l inline-block transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-x-[0.35em]"
      >
        [
      </span>
      <span className="relative mx-[0.1em] inline-block overflow-hidden px-[0.25em] py-[0.05em]">
        <span
          aria-hidden
          className="absolute inset-0 origin-left scale-x-0 bg-black transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] group-hover:scale-x-100"
        />
        <span className="relative transition-colors duration-300 group-hover:text-white">
          {children}
        </span>
      </span>
      <span
        aria-hidden
        className="bracket-r inline-block transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] group-hover:translate-x-[0.35em]"
      >
        ]
      </span>
    </button>
  );
}
