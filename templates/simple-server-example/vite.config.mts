import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'

export default defineConfig(() => ({
	plugins: [react()],
	root: path.join(__dirname, 'src/client'),
	publicDir: path.join(__dirname, 'public'),
	server: {
		port: 5757,
		proxy: { '/api/brainstorm': { target: 'http://localhost:5858', changeOrigin: true }, '/connect': { target: 'ws://localhost:5858', ws: true } },
	},
	optimizeDeps: {
		exclude: ['@tldraw/assets'],
	},
}))
