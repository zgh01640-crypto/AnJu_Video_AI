import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
  },
  test: {
    // jsdom 模拟浏览器 DOM 环境（window/document/navigator 等）
    environment: 'jsdom',
    // globals:true 让 describe/it/expect 不需要 import，和 Jest 写法一致
    globals: true,
    // setupFiles 在每个测试文件执行前先运行一次，用于全局 mock
    setupFiles: ['./src/__tests__/setup.js'],
    // 跳过 CSS 解析，测试不关心样式
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx'],
    },
  },
})
