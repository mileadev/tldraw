import { fetch, ProxyAgent } from 'undici'
import { API_HOSTS, type WorkerConfig } from './research-config'

export async function boundedJson(
	response: {
		body: {
			getReader(): {
				read(): Promise<{ done: boolean; value?: Uint8Array }>
				cancel(): Promise<unknown>
			}
		} | null
	},
	limit = 1_048_576
): Promise<any> {
	const reader = response.body?.getReader()
	if (!reader) throw new Error('Missing response body')
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			size += value.byteLength
			if (size > limit) throw new Error('Response size exceeded')
			chunks.push(value)
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} finally {
		await reader.cancel()
	}
}
export function providerTransport(config: WorkerConfig) {
	const dispatcher = new ProxyAgent({
		uri: config.proxy,
		connections: 1,
		requestTls: { rejectUnauthorized: true },
	})
	return {
		close: () => dispatcher.close(),
		request: async (url: string, init: RequestInit, signal: AbortSignal) => {
			const target = new URL(url)
			if (
				target.protocol !== 'https:' ||
				target.hostname !== API_HOSTS[config.provider] ||
				(target.port && target.port !== '443') ||
				target.username ||
				target.password ||
				target.hash
			)
				throw new Error('Provider destination denied')
			const response = await fetch(url, {
				method: init.method,
				headers: init.headers as Record<string, string>,
				body: init.body as string,
				signal,
				dispatcher,
				redirect: 'error',
			})
			if (!response.ok) {
				await response.body?.cancel()
				throw new Error('Provider request failed')
			}
			return boundedJson(response)
		},
	}
}
