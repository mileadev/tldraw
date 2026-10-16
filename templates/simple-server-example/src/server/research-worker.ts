import { workerConfig } from './research-config'
import { createResearchWorker } from './research-worker-app'

const app = createResearchWorker(workerConfig())
app
	.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 5860) })
	.catch(() => {
		process.exitCode = 1
	})
for (const event of ['SIGTERM', 'SIGINT'] as const)
	process.once(event, () => {
		void app.close()
	})
