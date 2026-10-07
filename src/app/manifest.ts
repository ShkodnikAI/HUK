import type { MetadataRoute } from "next";

// PWA manifest (H-105): brand colours from docs/BRAND.md; the icons are
// byte-identical copies of docs/assets/brand/icons/. No service worker — a
// live radio has no offline mode (ARCHITECTURE §5).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HUK",
    short_name: "HUK",
    description:
      "Free, non-commercial, international 24/7 radio for music that authors publish themselves.",
    start_url: "/en",
    display: "standalone",
    background_color: "#1A1B1F",
    theme_color: "#1A1B1F",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
