import { Newsreader } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-newsreader",
  display: "swap",
  fallback: ["Times New Roman", "Times", "serif"],
  // Next has no metric table for Newsreader; skip the automatic fallback tuning.
  adjustFontFallback: false,
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata = {
  title: "MOONBAG",
  description: "Did you leave a moonbag?",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${geistMono.variable}`}>
      <body className="bg-white font-serif text-black antialiased">{children}</body>
    </html>
  );
}
