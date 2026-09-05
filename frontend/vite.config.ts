// vite.config.ts — dev server and build configuration.

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Tailwind v4 is a Vite plugin rather than a PostCSS step, so there is no
  // tailwind.config.js and no postcss.config.js. Configuration that used to
  // live in those files now goes in CSS, via @theme.
  plugins: [react(), tailwindcss()],

  server: {
    // Pinned rather than left to pick a free port. The backend's CORS
    // allowlist names this exact origin, and a silently different port would
    // produce a CORS failure that looks like a backend bug.
    port: 5173,
    strictPort: true
  }
})
