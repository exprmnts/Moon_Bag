// Absolute URLs in the share tags, robots and sitemap come from here. Set
// NEXT_PUBLIC_SITE_URL on the host once the real domain exists; the Vercel
// deployment URL is the fallback.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://moonbagbot.vercel.app";
export const SITE_NAME = "Moonbag";
export const HEADLINE = "Did you leave a moonbag?";
export const DESCRIPTION =
  "A single-purpose Telegram bot that makes sure you always leave a moonbag. " +
  "You cannot sell it all until your targets are hit. $MOON, launched on Pons.";
// The Telegram bot. Set NEXT_PUBLIC_BOT_URL on the host to point elsewhere.
export const BOT_URL = process.env.NEXT_PUBLIC_BOT_URL ?? "https://t.me/mooonbagbot";
