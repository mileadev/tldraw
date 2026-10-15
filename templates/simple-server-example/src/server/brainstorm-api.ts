import type { FastifyInstance } from 'fastify'
import {
  addJob, boardAccess, clearSession, createInvite, createSession, createUser, db,
  extractSessionToken, getBoard, idPattern, jobsForBoard, listBoards, listInvites,
  listMembers, makeBoard, redeemInvite, removeMember, resolveSession, revokeInvite,
  verifyLogin, COOKIE_NAME
} from './brainstorm-db'
import { closeBoardSockets } from './connections'
import { enqueueResearch } from './brainstorm-research'

const MAX_BODY = 16384
const bucket = new Map<string, { count: number; until: number }>()
const rateLimit = (key: string, max: number): boolean => {
  const now = Date.now()
  const current = bucket.get(key)
  if (!current || now > current.until) { bucket.set(key, { count: 1, until: now + 60000 }); return true }
  current.count++
  return current.count <= max
}
function cookie(value: string, clear = false) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return COOKIE_NAME + '=' + value + '; Path=/; HttpOnly; SameSite=Strict' + secure +
    (clear ? '; Max-Age=0' : '; Max-Age=2592000')
}
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const validId = (v: unknown) => typeof v === 'string' && idPattern.test(v)
const isEditor = (role: string | null) => role === 'owner' || role === 'editor'
const providers = ['openai', 'gemini', 'mistral', 'web']

export function registerBrainstormRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/brainstorm/')) return
    if (req.method !== 'GET') {
      const origin = req.headers.origin
      const host = req.headers.host
      if (origin && (!host || new URL(origin).host !== host)) {
        return reply.code(403).send({ error: 'Cross-origin request rejected' })
      }
    }
  })
  app.post('/api/brainstorm/auth/register', async (req, reply) => {
    if (!rateLimit('register:' + req.ip, 5)) return reply.code(429).send({ error: 'Rate limited' })
    if (!isObject(req.body)) return reply.code(400).send({ error: 'Invalid request' })
    const { username, password } = req.body
    if (typeof username !== 'string' || typeof password !== 'string') return reply.code(400).send({ error: 'Invalid credentials' })
    try {
      const user = createUser(username, password)
      reply.header('Set-Cookie', cookie(createSession(user.id)))
      return { user }
    } catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : 'Registration failed' }) }
  })
  app.post('/api/brainstorm/auth/login', async (req, reply) => {
    if (!rateLimit('login:' + req.ip, 10)) return reply.code(429).send({ error: 'Rate limited' })
    if (!isObject(req.body)) return reply.code(400).send({ error: 'Invalid request' })
    const user = verifyLogin(String(req.body.username || ''), String(req.body.password || ''))
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' })
    reply.header('Set-Cookie', cookie(createSession(user.id)))
    return { user }
  })
  app.post('/api/brainstorm/auth/logout', async (req, reply) => {
    clearSession(extractSessionToken(req.headers.cookie))
    reply.header('Set-Cookie', cookie('', true))
    return { ok: true }
  })
  app.get('/api/brainstorm/me', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    return user ? { user } : reply.code(401).send({ error: 'Sign in required' })
  })
  app.get('/api/brainstorm/boards', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    return user ? { boards: listBoards(user.id) } : reply.code(401).send({ error: 'Sign in required' })
  })
  app.post('/api/brainstorm/boards', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    if (!user) return reply.code(401).send({ error: 'Sign in required' })
    if (!rateLimit('boards:' + user.id, 15)) return reply.code(429).send({ error: 'Rate limited' })
    const title = isObject(req.body) ? req.body.title : undefined
    if (typeof title !== 'string' || !title.trim()) return reply.code(400).send({ error: 'Title required' })
    return { board: makeBoard(user.id, title) }
  })
  app.get('/api/brainstorm/boards/:id', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    if (!user || !validId(id)) return reply.code(404).send({ error: 'Board not found' })
    const board = getBoard(user.id, id)
    return board ? { board } : reply.code(404).send({ error: 'Board not found' })
  })
  app.get('/api/brainstorm/boards/:id/members', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    return user && validId(id) && boardAccess(user.id, id)
      ? { members: listMembers(id) } : reply.code(404).send({ error: 'Board not found' })
  })
  app.delete('/api/brainstorm/boards/:id/members/:userId', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id, userId } = req.params as { id: string; userId: string }
    if (!user || !validId(id) || !validId(userId) || boardAccess(user.id, id) !== 'owner')
      return reply.code(403).send({ error: 'Owner required' })
    removeMember(id, userId)
    // Live revocation: drop the removed member's open collaboration sockets.
    closeBoardSockets(id, userId)
    return { ok: true }
  })
  app.post('/api/brainstorm/boards/:id/invites', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    if (!user || !validId(id) || boardAccess(user.id, id) !== 'owner') return reply.code(403).send({ error: 'Owner required' })
    const role = isObject(req.body) ? req.body.role : null
    if (role !== 'editor' && role !== 'viewer') return reply.code(400).send({ error: 'Invalid role' })
    return { invite: createInvite(id, role) }
  })
  app.get('/api/brainstorm/boards/:id/invites', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    return user && validId(id) && boardAccess(user.id, id) === 'owner'
      ? { invites: listInvites(id) } : reply.code(403).send({ error: 'Owner required' })
  })
  app.delete('/api/brainstorm/boards/:id/invites/:inviteId', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id, inviteId } = req.params as { id: string; inviteId: string }
    if (!user || !validId(id) || !validId(inviteId) || boardAccess(user.id, id) !== 'owner')
      return reply.code(403).send({ error: 'Owner required' })
    revokeInvite(id, inviteId)
    return { ok: true }
  })
  app.post('/api/brainstorm/boards/:id/join', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    const token = isObject(req.body) ? req.body.token : null
    if (!user) return reply.code(401).send({ error: 'Sign in required' })
    if (!validId(id) || typeof token !== 'string' || !redeemInvite(id, user.id, token))
      return reply.code(403).send({ error: 'Invalid or expired invitation' })
    return { board: getBoard(user.id, id) }
  })
  app.post('/api/brainstorm/boards/:id/research', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    if (!user || !validId(id) || !isEditor(boardAccess(user.id, id))) return reply.code(403).send({ error: 'Editor required' })
    if (!rateLimit('research:' + user.id, 10)) return reply.code(429).send({ error: 'Rate limited' })
    if (!isObject(req.body)) return reply.code(400).send({ error: 'Invalid research payload' })
    const { prompt, provider, parentShapeId } = req.body
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 6000 ||
      !providers.includes(String(provider)) ||
      !(parentShapeId == null || (typeof parentShapeId === 'string' && /^shape:[A-Za-z0-9_-]{1,128}$/.test(parentShapeId))))
      return reply.code(400).send({ error: 'Invalid research payload' })
    const job = addJob(user.id, id, provider as 'openai' | 'gemini' | 'mistral' | 'web', prompt, parentShapeId as string | null || null)
    enqueueResearch(job.id)
    return reply.code(202).send({ job })
  })
  app.get('/api/brainstorm/boards/:id/research', async (req, reply) => {
    const user = resolveSession(req.headers.cookie)
    const { id } = req.params as { id: string }
    if (!user || !validId(id) || !boardAccess(user.id, id)) return reply.code(404).send({ error: 'Board not found' })
    return { jobs: jobsForBoard(id) }
  })
}
