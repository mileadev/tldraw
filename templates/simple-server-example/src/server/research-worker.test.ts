import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type WorkerConfig } from './research-config'
import { createResearchWorker } from './research-worker-app'

const config: WorkerConfig = {
	provider: 'openai',
	key: 'provider-key-very-secret',
	secret: 'worker-token-very-secret',
	proxy: 'http://proxy:3128/',
}
const apps: ReturnType<typeof createResearchWorker>[] = []
afterEach(async () => {
	await Promise.all(apps.splice(0).map((a) => a.close()))
})
function worker(
	request = vi
		.fn()
		.mockResolvedValue({ output: [{ content: [{ type: 'output_text', text: 'answer' }] }] }),
	cfg = config,
	timeout = 1000
) {
	const app = createResearchWorker(cfg, { request, close: async () => {} }, timeout)
	apps.push(app)
	return { app, request }
}
const call = (
	app: ReturnType<typeof createResearchWorker>,
	payload: unknown = { provider: 'openai', prompt: 'research', system: 'trusted instructions' },
	token = config.secret
) =>
	app.inject({
		method: 'POST',
		url: '/research',
		headers: { authorization: 'Bearer ' + token },
		payload: payload as any,
	})

describe('Provider worker boundary', () => {
	it('rejects unauthorized calls before invoking a provider', async () => {
		const { app, request } = worker()
		expect((await call(app, undefined, 'wrong')).statusCode).toBe(401)
		expect(request).not.toHaveBeenCalled()
	})
	it('rejects cross-provider credentials and provider switching', async () => {
		const { app, request } = worker()
		expect((await call(app, { provider: 'gemini', prompt: 'x', system: 'x' })).statusCode).toBe(403)
		expect(request).not.toHaveBeenCalled()
	})
	it.each([
		null,
		[],
		{},
		{ provider: 'openai', prompt: ' ', system: '' },
		{ provider: 'openai', prompt: 'x'.repeat(6001), system: '' },
	])('rejects malformed input %j', async (payload) => {
		const { app, request } = worker()
		expect((await call(app, payload)).statusCode).toBe(400)
		expect(request).not.toHaveBeenCalled()
	})
	it('returns citations and keeps authorization out of the result', async () => {
		const request = vi.fn().mockResolvedValue({
			output: [
				{
					content: [
						{
							type: 'output_text',
							text: 'answer',
							annotations: [{ type: 'url_citation', title: 'Source', url: 'https://example.com' }],
						},
					],
				},
			],
		})
		const { app } = worker(request)
		const result = await call(app)
		expect(result.statusCode).toBe(200)
		expect(result.json()).toEqual({
			output: 'answer\n',
			references: [{ title: 'Source', url: 'https://example.com' }],
		})
		expect(request.mock.calls[0][1].headers.authorization).toBe('Bearer ' + config.key)
		expect(JSON.parse(request.mock.calls[0][1].body).store).toBe(false)
	})
	it('does not echo credential-bearing upstream failures and recovers', async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new Error(config.key + config.secret))
			.mockResolvedValue({ output: [] })
		const { app } = worker(request)
		const result = await call(app)
		expect(result.statusCode).toBe(502)
		expect(result.json()).toEqual({ error: 'Provider request failed' })
		expect((await app.inject('/health')).json()).toEqual({ ok: true })
	})
	it('rejects credentials reflected inside successful upstream output', async () => {
		const { app } = worker(
			vi
				.fn()
				.mockResolvedValue({ output: [{ content: [{ type: 'output_text', text: config.key }] }] })
		)
		const result = await call(app)
		expect(result.statusCode).toBe(502)
		expect(result.body).not.toContain(config.key)
	})
	it('limits in-flight work, aborts timeout, and accepts the next job', async () => {
		const request = vi
			.fn()
			.mockImplementation(
				(_url, _init, signal: AbortSignal) =>
					new Promise((_resolve, reject) =>
						signal.addEventListener('abort', () => reject(new Error('timeout')))
					)
			)
		const { app } = worker(request, config, 80)
		const first = call(app)
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce(), { interval: 1 })
		expect((await call(app)).statusCode).toBe(429)
		expect((await first).statusCode).toBe(502)
		request.mockResolvedValue({
			output: [{ content: [{ type: 'output_text', text: 'recovered' }] }],
		})
		expect((await call(app)).statusCode).toBe(200)
	})
	it.each(['gemini', 'mistral', 'web'] as const)(
		'uses only the selected %s provider',
		async (provider) => {
			const response =
				provider === 'gemini'
					? { candidates: [{ content: { parts: [{ text: 'answer' }] } }] }
					: provider === 'mistral'
						? {
								id: 'agent-id',
								outputs: [{ type: 'message.output', content: [{ type: 'text', text: 'answer' }] }],
							}
						: { results: [{ title: 'result', content: 'extract', url: 'https://example.com' }] }
			const { app, request } = worker(vi.fn().mockResolvedValue(response), { ...config, provider })
			expect((await call(app, { provider, prompt: 'a', system: 'b' })).statusCode).toBe(200)
			for (const [url] of request.mock.calls) expect(url).not.toContain('api.openai.com')
			if (provider === 'mistral')
				expect(JSON.parse(request.mock.calls[1][1].body).store).toBe(false)
			if (provider === 'web')
				expect(JSON.parse(request.mock.calls[0][1].body).include_answer).toBe(false)
		}
	)
})

it('aborts upstream work when the HTTP caller disconnects and releases its slot', async () => {
	const request = vi
		.fn()
		.mockImplementation(
			(_url, _init, signal: AbortSignal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(new Error('aborted')))
				)
		)
	const { app } = worker(request)
	const origin = await app.listen({ host: '127.0.0.1', port: 0 })
	const req = httpRequest(origin + '/research', {
		method: 'POST',
		headers: { authorization: 'Bearer ' + config.secret, 'content-type': 'application/json' },
	})
	req.on('error', () => {})
	req.end(JSON.stringify({ provider: 'openai', prompt: 'x', system: 'x' }))
	await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
	const signal = request.mock.calls[0][2] as AbortSignal
	req.destroy()
	await vi.waitFor(() => expect(signal.aborted).toBe(true))
	request.mockResolvedValue({ output: [{ content: [{ type: 'output_text', text: 'recovered' }] }] })
	expect((await call(app)).statusCode).toBe(200)
})
