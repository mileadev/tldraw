import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/server/**/*.test.ts'],
		testTimeout: 10000,
		fileParallelism: false,
	},
})
