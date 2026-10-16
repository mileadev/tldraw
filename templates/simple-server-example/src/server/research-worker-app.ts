import { randomUUID, timingSafeEqual } from 'node:crypto'
import fastify from 'fastify'
import { type WorkerConfig } from './research-config'
import { providerTransport } from './research-transport'

export function createResearchWorker(
	config: WorkerConfig,
	transport = providerTransport(config),
	timeoutMs = 105000
) {
	const app = fastify({ bodyLimit: 16384, logger: false, requestTimeout: 10000 })
	const keys: Record<string, string> = { [config.provider]: config.key }
	let busy = false
	app.addHook('onClose', async () => {
		await transport.close()
	})
	app.setErrorHandler((_error, _request, reply) => {
		void reply.code(400).send({ error: 'Invalid request' })
	})
	const models = {
		openai: process.env.OPENAI_MODEL || 'gpt-4.1',
		gemini: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
		mistral: process.env.MISTRAL_MODEL || 'mistral-medium-latest',
	}
	const MAX_OUTPUT = 60000
	interface Reference {
		title: string
		url: string
	}

	const reference = (title: unknown, url: unknown): Reference | null =>
		typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 2048
			? { title: String(title || url).slice(0, 200), url }
			: null

	let signal: AbortSignal
	const upstream = (url: string, init: RequestInit) => transport.request(url, init, signal)

	// OpenAI (ChatGPT): Responses API with the web_search tool. Citations are
	// returned as url_citation annotations on the output text.
	async function openaiResearch(system: string, prompt: string) {
		const json = await upstream('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: { authorization: 'Bearer ' + keys.openai, 'content-type': 'application/json' },
			body: JSON.stringify({
				model: models.openai,
				store: false,
				tools: [{ type: 'web_search' }],
				input: system + '\nQuestion: ' + prompt,
			}),
		})
		let output = ''
		const references: Reference[] = []
		for (const item of json.output || []) {
			for (const part of item?.content || []) {
				if (part?.type === 'output_text' && typeof part.text === 'string') {
					output += part.text + '\n'
					for (const annotation of part.annotations || []) {
						const ref =
							annotation?.type === 'url_citation'
								? reference(annotation.title, annotation.url)
								: null
						if (ref) references.push(ref)
					}
				}
			}
		}
		return { output: output.slice(0, MAX_OUTPUT), references }
	}

	// Gemini: generateContent with the google_search tool. Grounded citations come
	// from groundingMetadata.groundingChunks.
	async function geminiResearch(system: string, prompt: string) {
		const json = await upstream(
			'https://generativelanguage.googleapis.com/v1beta/models/' +
				encodeURIComponent(models.gemini) +
				':generateContent',
			{
				method: 'POST',
				headers: { 'x-goog-api-key': keys.gemini!, 'content-type': 'application/json' },
				body: JSON.stringify({
					systemInstruction: { parts: [{ text: system }] },
					contents: [{ parts: [{ text: prompt }] }],
					tools: [{ google_search: {} }],
				}),
			}
		)
		const candidate = json.candidates?.[0]
		const output = (candidate?.content?.parts || []).map((x: any) => x?.text || '').join('\n')
		const references: Reference[] = []
		for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
			const ref = reference(chunk?.web?.title || chunk?.web?.domain, chunk?.web?.uri)
			if (ref) references.push(ref)
		}
		return { output: String(output).slice(0, MAX_OUTPUT), references }
	}

	// Mistral: Agents API agent with the built-in web_search connector, invoked
	// through the Conversations API. Real source URLs come back as tool_reference
	// chunks alongside the answer text. The agent is created once and reused.
	const mistralAgents = new Map<string, string>()
	async function mistralResearch(system: string, prompt: string) {
		const model = models.mistral
		let agentId = mistralAgents.get(model)
		if (!agentId) {
			const created = await upstream('https://api.mistral.ai/v1/agents', {
				method: 'POST',
				headers: { authorization: 'Bearer ' + keys.mistral, 'content-type': 'application/json' },
				body: JSON.stringify({
					model,
					name: 'Brainstorm researcher ' + randomUUID().slice(0, 8),
					description: 'Deep-research agent for the tldraw brainstorming canvas.',
					instructions: system,
					tools: [{ type: 'web_search' }],
				}),
			})
			agentId = String(created?.id || '')
			if (!agentId) throw new Error('Mistral agent creation failed')
			mistralAgents.set(model, agentId)
		}
		const json = await upstream('https://api.mistral.ai/v1/conversations', {
			method: 'POST',
			headers: { authorization: 'Bearer ' + keys.mistral, 'content-type': 'application/json' },
			body: JSON.stringify({ inputs: prompt, stream: false, store: false, agent_id: agentId }),
		})
		let output = ''
		const references: Reference[] = []
		for (const entry of json.outputs || []) {
			if (entry?.type !== 'message.output') continue
			for (const chunk of entry.content || []) {
				if (chunk?.type === 'text' && typeof chunk.text === 'string') output += chunk.text + '\n'
				else {
					const ref = chunk?.type === 'tool_reference' ? reference(chunk.title, chunk.url) : null
					if (ref) references.push(ref)
				}
			}
		}
		if (!output.trim() && !references.length) throw new Error('Empty Mistral research response')
		return { output: output.slice(0, MAX_OUTPUT), references }
	}

	// All-web provider: direct ranked web search via Tavily. No language model is
	// involved; every finding is an extract of a real page, so nothing is
	// synthesized and no citations can be fabricated.
	async function webResearch(prompt: string) {
		const json = await upstream('https://api.tavily.com/search', {
			method: 'POST',
			headers: { authorization: 'Bearer ' + keys.web, 'content-type': 'application/json' },
			body: JSON.stringify({
				query: prompt,
				max_results: 8,
				search_depth: 'advanced',
				include_answer: false,
			}),
		})
		const findings = (Array.isArray(json.results) ? json.results : [])
			.map((r: any) => ({
				title: String(r?.title || 'Result').slice(0, 200),
				summary: String(r?.content || '').slice(0, 1500),
				sources: [reference(r?.title, r?.url)].filter(
					(x: Reference | null): x is Reference => x !== null
				),
			}))
			.filter((f: { sources: Reference[] }) => f.sources.length > 0)
		if (!findings.length) throw new Error('No web results returned')
		const summary =
			typeof json.answer === 'string' && json.answer.trim()
				? json.answer
				: 'All-web search results (direct page extracts, no model synthesis).'
		return {
			output: JSON.stringify({ summary: summary.slice(0, MAX_OUTPUT), findings }),
			references: [] as Reference[],
		}
	}

	app.get('/health', async () => ({ ok: true }))
	app.addHook('onRequest', async (req, reply) => {
		if (req.url === '/health' && req.method === 'GET') return
		const actual = Buffer.from(req.headers.authorization || '')
		const expected = Buffer.from('Bearer ' + config.secret)
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			return reply.code(401).send({ error: 'Unauthorized' })
	})
	app.post('/research', async (req, reply) => {
		const payload = req.body as Record<string, unknown> | null
		if (
			!payload ||
			Array.isArray(payload) ||
			typeof payload.prompt !== 'string' ||
			!payload.prompt.trim() ||
			payload.prompt.length > 6000 ||
			typeof payload.system !== 'string' ||
			payload.system.length > 2000
		)
			return reply.code(400).send({ error: 'Invalid request' })
		if (payload.provider !== config.provider)
			return reply.code(403).send({ error: 'Provider denied' })
		if (busy) return reply.code(429).send({ error: 'Worker busy' })
		busy = true
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		const abort = () => {
			if (!reply.raw.writableEnded) controller.abort()
		}
		reply.raw.once('close', abort)
		signal = controller.signal
		try {
			const { prompt, system } = payload as { prompt: string; system: string }
			const result =
				config.provider === 'openai'
					? await openaiResearch(system, prompt)
					: config.provider === 'gemini'
						? await geminiResearch(system, prompt)
						: config.provider === 'mistral'
							? await mistralResearch(system, prompt)
							: await webResearch(prompt)
			if (!result.output.trim()) throw new Error('Empty provider response')
			const serialized = JSON.stringify(result)
			if (serialized.includes(config.key) || serialized.includes(config.secret))
				throw new Error('Sensitive response')
			return result
		} catch {
			return reply.code(502).send({ error: 'Provider request failed' })
		} finally {
			clearTimeout(timer)
			reply.raw.off('close', abort)
			busy = false
		}
	})
	return app
}
