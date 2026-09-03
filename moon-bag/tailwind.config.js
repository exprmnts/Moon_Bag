/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,mdx}"],
  theme: {
    // Strict monochrome: no other color utilities exist in this project.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      black: "#000",
      white: "#fff",
    },
    fontFamily: {
      serif: ["var(--font-newsreader)", "Times New Roman", "Times", "serif"],
      mono: ["var(--font-geist-mono)", "ui-monospace", "Menlo", "monospace"],
    },
    extend: {},
  },
  plugins: [],
};
