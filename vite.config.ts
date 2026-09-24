import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart({
      // 所有课程页面在构建期预渲染为静态 HTML，Worker 只负责兜底和客户端导航时的数据请求
      prerender: { enabled: true, crawlLinks: true },
    }),
    react(),
  ],
})
