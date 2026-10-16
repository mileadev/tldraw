import { readFileSync } from 'node:fs'

export const PROVIDERS = ['openai', 'gemini', 'mistral', 'web'] as const
export type ResearchProvider = (typeof PROVIDERS)[number]
export const API_HOSTS: Record<ResearchProvider, string> = {
	openai: 'api.openai.com',
	gemini: 'generativelanguage.googleapis.com',
	mistral: 'api.mistral.ai',
	web: 'api.tavily.com',
}
const KEY_NAMES = {
	openai: 'OPENAI_API_KEY',
	gemini: 'GEMINI_API_KEY',
	mistral: 'MISTRAL_API_KEY',
	web: 'TAVILY_API_KEY',
}
export type Env = Record<string, string | undefined>

export function readSecret(env: Env, name: string): string {
	// File injection is mandatory; reject ambient secrets rather than silently preferring one.
	if (env[name] || !env[name + '_FILE'])
		throw new Error(name + '_FILE is required; inline secrets are forbidden')
	const value = readFileSync(env[name + '_FILE']!, 'utf8').trim()
	if (value.length < 16 || value.length > 4096 || /[\r\n]/.test(value))
		throw new Error('Invalid secret file: ' + name)
	return value
}
export function workerConfig(env: Env = process.env) {
	const provider = env.PROVIDER as ResearchProvider
	if (!PROVIDERS.includes(provider)) throw new Error('Exactly one PROVIDER is required')
	for (const p of PROVIDERS) {
		const name = KEY_NAMES[p]
		if (p !== provider && (env[name] || env[name + '_FILE']))
			throw new Error('Foreign provider credential is forbidden')
	}
	const proxy = new URL(env.RESEARCH_EGRESS_PROXY || '')
	if (
		proxy.protocol !== 'http:' ||
		proxy.username ||
		proxy.password ||
		proxy.pathname !== '/' ||
		proxy.search ||
		proxy.hash
	)
		throw new Error('An HTTP egress proxy without credentials is required')
	return {
		provider,
		key: readSecret(env, KEY_NAMES[provider]),
		secret: readSecret(env, 'RESEARCH_WORKER_SECRET'),
		proxy: proxy.href,
	}
}
export type WorkerConfig = ReturnType<typeof workerConfig>

export function workerEndpoints(
	env: Env = process.env
): Partial<Record<ResearchProvider, { url: string; secret: string }>> {
	// Missing providers stay disabled. Malformed mappings must never fall back to a shared worker.
	const mapping: unknown = JSON.parse(env.RESEARCH_WORKER_URLS || '{}')
	if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
		throw new Error('Invalid worker mapping')
	const endpoints: Partial<Record<ResearchProvider, { url: string; secret: string }>> = {}
	for (const [provider, value] of Object.entries(mapping)) {
		if (!PROVIDERS.includes(provider as ResearchProvider) || typeof value !== 'string')
			throw new Error('Invalid worker endpoint')
		const url = new URL(value)
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		)
			throw new Error('Invalid worker endpoint')
		endpoints[provider as ResearchProvider] = {
			url: url.origin,
			secret: readSecret(env, 'RESEARCH_' + provider.toUpperCase() + '_SECRET'),
		}
	}
	const tokens = Object.values(endpoints).map((endpoint) => endpoint.secret)
	if (new Set(tokens).size !== tokens.length) throw new Error('Worker tokens must be distinct')
	return endpoints
}
