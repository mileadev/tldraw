import { createBrainstormServer } from './server-app'

const app = createBrainstormServer()
app
	.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 5858) })
	.catch(() => {
		process.exitCode = 1
	})
for (const event of ['SIGTERM', 'SIGINT'] as const)
	process.once(event, () => {
		void app.close()
	})
