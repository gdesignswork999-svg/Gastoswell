import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Gastoswell - Your money, in balance',
        short_name: 'Gastoswell',
        description: 'Track expenses, accounts, bills, savings, and debt offline.',
        theme_color: '#eef2ff',
        background_color: '#eef2ff',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          {
            src: 'gastoswell-1080.png',
            sizes: '1080x1080',
            type: 'image/png',
            purpose: 'any'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,jpg,jpeg,png,svg}'],
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000'
    }
  }
});
