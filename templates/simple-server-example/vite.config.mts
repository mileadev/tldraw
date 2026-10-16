import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(() => ({
	plugins: [react()],
	root: path.join(__dirname, 'src/client'),
	publicDir: path.join(__dirname, 'public'),
	server: {
		port: 5757,
		proxy: {
			'/api/brainstorm': { target: 'http://127.0.0.1:5858', changeOrigin: false },
			'/connect': { target: 'ws://127.0.0.1:5858', ws: true },
		},
	},
	optimizeDeps: {
		exclude: ['@tldraw/assets'],
	},
}))
