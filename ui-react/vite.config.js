import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: :5173 제공, /api(REST+SSE)는 실험 서버(:3848)로 프록시.
// 운영 서버(:3847)는 손대지 않는다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
      },
      // 터미널 WS — 서버가 Origin==Host를 강제하므로 dev에서만 Origin을 맞춘다
      '/ws-term': {
        target: 'ws://127.0.0.1:3847',
        ws: true,
        rewrite: () => '/',
        headers: { origin: 'http://127.0.0.1:3847' },
      },
    },
  },
});
