import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.ts",
      registerType: "autoUpdate",
      includeAssets: [
        "favicon.png", "favicon-16.png",
        "apple-touch-icon.png",
        "pwa-192x192.png", "pwa-512x512.png",
        "logo.png", "icon.png",
      ],
      manifest: {
        name: "LumixPay",
        short_name: "LumixPay",
        description: "Stablecoin payment infrastructure",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "portrait",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          // maskable — same art but declared for adaptive icon support on Android
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Single proxy rule: all /api/* → http://localhost:4000/* (strips /api prefix)
      // REST API — strips /api prefix
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // SSE stream — pass through as-is (no prefix strip)
      "/stream": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
