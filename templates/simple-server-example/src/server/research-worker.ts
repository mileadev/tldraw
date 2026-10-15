import fastify from 'fastify'

const app = fastify({ bodyLimit: 16384 })
const secret = process.env.RESEARCH_WORKER_SECRET
const keys = {
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  mistral: process.env.MISTRAL_API_KEY
}
const models = {
  openai: process.env.OPENAI_MODEL || 'gpt-4.1',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
  mistral: process.env.MISTRAL_MODEL || 'mistral-large-latest'
}
const message = (system: string, prompt: string) => system + '\nQuestion: ' + prompt
type Provider = keyof typeof keys
const upstream = async (url: string, init: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(105000) })
  if (!response.ok) throw new Error('Provider request failed with status ' + response.status)
  return response.json() as Promise<any>
}

app.post('/research', async (req, reply) => {
  if (!secret || req.headers.authorization !== 'Bearer ' + secret)
    return reply.code(401).send({ error: 'Unauthorized' })
  const payload = req.body as Record<string, unknown>
  if (!payload || !['openai','gemini','mistral'].includes(String(payload.provider)) ||
    typeof payload.prompt !== 'string' || payload.prompt.length > 6000 ||
    typeof payload.system !== 'string' || payload.system.length > 2000)
    return reply.code(400).send({ error: 'Invalid request' })
  const provider = payload.provider as Provider
  if (!keys[provider]) return reply.code(503).send({ error: 'Provider not configured' })
  const prompt = message(payload.system, payload.prompt)
  try {
    if (provider === 'openai') {
      const json = await upstream('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + keys.openai, 'content-type': 'application/json' },
        body: JSON.stringify({ model: models.openai, tools: [{ type: 'web_search' }], input: prompt })
      })
      const output = (json.output || []).flatMap((x: any) => x.content || [])
        .filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('\n')
      return { output }
    }
    if (provider === 'gemini') {
      const json = await upstream('https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(models.gemini) + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': keys.gemini!, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
      })
      const output = (json.candidates?.[0]?.content?.parts || []).map((x: any) => x.text || '').join('\n')
      return { output }
    }
    // Mistral's standard chat endpoint has no guaranteed live-search tool.
    // Label the result as model knowledge until a search-enabled agent is configured.
    const json = await upstream('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + keys.mistral, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: models.mistral,
        messages: [{ role: 'system', content: payload.system + ' If live web search is not available, disclose it and do not claim fresh sources.' },
          { role: 'user', content: payload.prompt }]
      })
    })
    return { output: json.choices?.[0]?.message?.content || '' }
  } catch (err) {
    req.log.warn({ provider, message: err instanceof Error ? err.message : 'Unknown failure' }, 'Research failed')
    return reply.code(502).send({ error: 'Provider request failed' })
  }
})
app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 5860) })
