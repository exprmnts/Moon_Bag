"use client";

// The pill from homepage variation 02: hairline outline, fills black on hover.
export default function PillButton({ children, onClick }) {
  return (
    <button
      type="button"
      data-cursor
      onClick={() => onClick?.()}
      className="ml-[0.25em] inline-block rounded-full border-[1.5px] border-black px-[1.1em] py-[0.22em] align-baseline leading-none transition-all duration-300 hover:bg-black hover:text-white active:scale-95"
    >
      {children}
    </button>
  );
}
