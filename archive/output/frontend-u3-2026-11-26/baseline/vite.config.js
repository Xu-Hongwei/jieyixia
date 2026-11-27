import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 运行时复用权威契约 schema.json（备份校验器单一来源）；与 jsconfig 的 @contract/* 一致。
      '@contract': fileURLToPath(new URL('../contract', import.meta.url)),
      // 冻结 0.4.0 schema：v1 旧备份校验专用，字节不变（contract/frozen/verify_frozen.py 守卫）。
      '@frozen-040': fileURLToPath(new URL('../contract/frozen/0.4.0', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        // 联调目标可用 JXL_DEV_BACKEND 覆盖（默认本机 8000）；鉴权令牌只在服务端注入，
        // 浏览器端不出现固定 token（无 VITE_* 密钥）。浏览器已带 Authorization 时不覆盖。
        target: process.env.JXL_DEV_BACKEND || 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure(proxy) {
          const token = process.env.JXL_API_TOKEN
          if (!token) return
          proxy.on('proxyReq', (proxyReq) => {
            if (!proxyReq.getHeader('authorization')) proxyReq.setHeader('Authorization', `Bearer ${token}`)
          })
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})