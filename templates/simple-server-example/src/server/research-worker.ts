import fastify from 'fastify'
import { randomUUID } from 'node:crypto'

// Research worker: executes deep-research jobs for exactly one board at a
// time, calling the provider APIs directly from this separate process.
//
// Deployment: run each provider in its own container (see Dockerfile and
// docker-compose.yml) with PROVIDERS set to that single provider and only that
// provider's API key present. The worker binds to 127.0.0.1 by default; when
// containerized, set HOST=0.0.0.0 and keep the container on a private network
// (never publish the worker port). Restrict each container's outbound traffic
// to its provider's API host at the host firewall / orchestrator level.
//
// We never scrape consumer chat web interfaces; research goes through the
// providers' official APIs, and every returned citation comes from the
// provider's own web search annotations.

const app = fastify({ bodyLimit: 16384 })
const secret = process.env.RESEARCH_WORKER_SECRET
const allowed = (process.env.PROVIDERS || 'openai,gemini,mistral,web')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const keys: Record<string, string | undefined> = {
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  mistral: process.env.MISTRAL_API_KEY,
  web: process.env.TAVILY_API_KEY
}
const models = {
  openai: process.env.OPENAI_MODEL || 'gpt-4.1',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
  mistral: process.env.MISTRAL_MODEL || 'mistral-medium-latest'
}
const MAX_OUTPUT = 60000
type Provider = 'openai' | 'gemini' | 'mistral' | 'web'
type Reference = { title: string; url: string }

const reference = (title: unknown, url: unknown): Reference | null =>
  typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 2048
    ? { title: String(title || url).slice(0, 200), url }
    : null

const upstream = async (url: string, init: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(105000) })
  if (!response.ok) throw new Error('Provider request failed with status ' + response.status)
  return response.json() as Promise<any>
}

// OpenAI (ChatGPT): Responses API with the web_search tool. Citations are
// returned as url_citation annotations on the output text.
async function openaiResearch(system: string, prompt: string) {
  const json = await upstream('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'authorization': 'Bearer ' + keys.openai, 'content-type': 'application/json' },
    body: JSON.stringify({ model: models.openai, tools: [{ type: 'web_search' }], input: system + '\nQuestion: ' + prompt })
  })
  let output = ''
  const references: Reference[] = []
  for (const item of json.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        output += part.text + '\n'
        for (const annotation of part.annotations || []) {
          const ref = annotation?.type === 'url_citation' ? reference(annotation.title, annotation.url) : null
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
  const json = await upstream('https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(models.gemini) + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': keys.gemini!, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    })
  })
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
      headers: { 'authorization': 'Bearer ' + keys.mistral, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        name: 'Brainstorm researcher ' + randomUUID().slice(0, 8),
        description: 'Deep-research agent for the tldraw brainstorming canvas.',
        instructions: system,
        tools: [{ type: 'web_search' }]
      })
    })
    agentId = String(created?.id || '')
    if (!agentId) throw new Error('Mistral agent creation failed')
    mistralAgents.set(model, agentId)
  }
  const json = await upstream('https://api.mistral.ai/v1/conversations', {
    method: 'POST',
    headers: { 'authorization': 'Bearer ' + keys.mistral, 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: prompt, stream: false, store: false, agent_id: agentId })
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
    headers: { 'authorization': 'Bearer ' + keys.web, 'content-type': 'application/json' },
    body: JSON.stringify({ query: prompt, max_results: 8, search_depth: 'advanced', include_answer: true })
  })
  const findings = (Array.isArray(json.results) ? json.results : [])
    .map((r: any) => ({
      title: String(r?.title || 'Result').slice(0, 200),
      summary: String(r?.content || '').slice(0, 1500),
      sources: [reference(r?.title, r?.url)].filter((x: Reference | null): x is Reference => x !== null)
    }))
    .filter((f: { sources: Reference[] }) => f.sources.length > 0)
  if (!findings.length) throw new Error('No web results returned')
  const summary = typeof json.answer === 'string' && json.answer.trim()
    ? json.answer : 'All-web search results (direct page extracts, no model synthesis).'
  return { output: JSON.stringify({ summary: summary.slice(0, MAX_OUTPUT), findings }), references: [] as Reference[] }
}

app.post('/research', async (req, reply) => {
  if (!secret || req.headers.authorization !== 'Bearer ' + secret)
    return reply.code(401).send({ error: 'Unauthorized' })
  const payload = req.body as Record<string, unknown>
  if (!payload || !['openai', 'gemini', 'mistral', 'web'].includes(String(payload.provider)) ||
    typeof payload.prompt !== 'string' || payload.prompt.length > 6000 ||
    typeof payload.system !== 'string' || payload.system.length > 2000)
    return reply.code(400).send({ error: 'Invalid request' })
  const provider = payload.provider as Provider
  if (!allowed.includes(provider)) return reply.code(503).send({ error: 'Provider not served by this worker' })
  if (!keys[provider]) return reply.code(503).send({ error: 'Provider not configured' })
  const prompt = String(payload.prompt)
  const system = String(payload.system)
  try {
    if (provider === 'openai') return await openaiResearch(system, prompt)
    if (provider === 'gemini') return await geminiResearch(system, prompt)
    if (provider === 'mistral') return await mistralResearch(system, prompt)
    return await webResearch(prompt)
  } catch (err) {
    req.log.warn({ provider, message: err instanceof Error ? err.message : 'Unknown failure' }, 'Research failed')
    return reply.code(502).send({ error: 'Provider request failed' })
  }
})
app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 5860) })
