import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { boundedJson, providerTransport } from './research-transport'

const config = {
	provider: 'openai' as const,
	key: 'unused',
	secret: 'unused',
	proxy: 'http://127.0.0.1:1/',
}
describe('Outbound transport', () => {
	it.each([
		'http://api.openai.com/x',
		'https://api.openai.com.evil.test/x',
		'https://api.mistral.ai/x',
		'https://127.0.0.1/x',
		'https://169.254.169.254/x',
		'https://api.openai.com:444/x',
		'https://key@api.openai.com/x',
	])('denies %s before making a connection', async (url) => {
		const t = providerTransport(config)
		await expect(t.request(url, { method: 'POST' }, AbortSignal.timeout(100))).rejects.toThrow(
			'destination denied'
		)
		await t.close()
	})
	it('sends CONNECT to the configured proxy and never falls back on denial', async () => {
		const proxy = createServer()
		const connect = vi.fn((_req, socket) =>
			socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
		)
		proxy.on('connect', connect)
		proxy.listen(0, '127.0.0.1')
		await once(proxy, 'listening')
		const address = proxy.address() as { port: number }
		const t = providerTransport({ ...config, proxy: 'http://127.0.0.1:' + address.port })
		try {
			await expect(
				t.request(
					'https://api.openai.com/v1/responses',
					{ method: 'POST' },
					AbortSignal.timeout(1000)
				)
			).rejects.toThrow()
			expect(connect).toHaveBeenCalledOnce()
			expect(connect.mock.calls[0][0].url).toBe('api.openai.com:443')
		} finally {
			await t.close()
			await new Promise<void>((resolve) => proxy.close(() => resolve()))
		}
	})
	it('bounds response bytes and rejects malformed JSON', async () => {
		await expect(boundedJson(new Response('x'.repeat(100)), 99)).rejects.toThrow('size exceeded')
		await expect(boundedJson(new Response('not json'))).rejects.toThrow()
		await expect(boundedJson(new Response('{"ok":true}'))).resolves.toEqual({ ok: true })
	})
})
