import { Newsreader } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { DESCRIPTION, HEADLINE, SITE_NAME, SITE_URL } from "./site";

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

// Icons and share images come from the file conventions in this folder:
// favicon.ico, icon.svg, apple-icon.png, opengraph-image.png, twitter-image.png.
export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} — ${HEADLINE}`, template: `%s — ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "moonbag",
    "moon bag",
    "Moonbag Bot",
    "$MOON",
    "Telegram trading bot",
    "Solana",
    "memecoin",
    "reverse copy trade",
    "paperhands",
    "hodl",
  ],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: "finance",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    locale: "en_US",
    title: HEADLINE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: HEADLINE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
  colorScheme: "light",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: SITE_NAME, url: SITE_URL, description: DESCRIPTION },
    {
      "@type": "SoftwareApplication",
      name: "Moonbag Bot",
      url: SITE_URL,
      description: DESCRIPTION,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Telegram",
    },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${geistMono.variable}`}>
      <body className="bg-white font-serif text-black antialiased">
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
