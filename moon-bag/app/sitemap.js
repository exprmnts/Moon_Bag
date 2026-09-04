import { SITE_URL } from "./site";

export default function sitemap() {
  return [{ url: SITE_URL, lastModified: new Date(), changeFrequency: "monthly", priority: 1 }];
}
