import fs from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

/**
 * Serves the Vercel-style functions in api/ from the dev server, so the app talks to /api/* while developing.
 * Functions export web-standard handlers (GET, POST) and read their keys from the environment only.
 */
function apiDev(): Plugin {
  return {
    name: 'recall-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/api/')) return next()
        const rel = url.pathname.slice('/api/'.length).replace(/\/+$/, '')
        if (!/^[A-Za-z0-9/_-]+$/.test(rel) || rel.startsWith('_') || rel.includes('/_')) return next()
        const parts = rel.split('/')
        const candidates = [`api/${rel}.ts`, parts.length === 2 ? `api/${parts[0]}/[step].ts` : '']
        const file = candidates.find((c) => c && fs.existsSync(path.resolve(__dirname, c)))
        if (!file) return next()
        try {
          const mod = (await server.ssrLoadModule(`/${file}`)) as Record<string, unknown>
          const handler = mod[req.method ?? 'GET']
          if (typeof handler !== 'function') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed.' }))
            return
          }
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
          const response = (await (handler as (r: Request) => Promise<Response> | Response)(
            new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
          )) as Response
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'The function failed.' }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), nodePolyfills(), apiDev()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@recall/sdk': path.resolve(__dirname, './packages/sdk/src/index.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    allowedHosts: true,
    cors: true,
  },
})
