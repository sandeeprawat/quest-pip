import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { companionPlugin } from './server/companion.js';

export default defineConfig({
  plugins: [basicSsl(), companionPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    https: {},
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/server/**'],
    },
  },
});
