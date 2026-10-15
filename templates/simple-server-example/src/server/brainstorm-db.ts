import Database from 'better-sqlite3'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Role = 'owner' | 'editor' | 'viewer'
export type Provider = 'openai' | 'gemini' | 'mistral'

const dataDir = process.env.BRAINSTORM_DATA_DIR || join(process.cwd(), '.brainstorm-data')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
export const db = new Database(join(dataDir, 'brainstorm.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec([
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS members (board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN (\'owner\',\'editor\',\'viewer\')), PRIMARY KEY(board_id,user_id))',
  'CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN (\'editor\',\'viewer\')), expires_at INTEGER NOT NULL, revoked_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS research_jobs (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, prompt TEXT NOT NULL, parent_shape_id TEXT, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_board ON research_jobs(board_id,created_at)'
].join(';') + ';')

const now = () => Date.now()
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const userNamePattern = /^[a-z][a-z0-9_-]{2,31}$/
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const COOKIE_NAME = 'research_canvas_session'

export type User = { id: string; username: string }
export type Board = { id: string; title: string; owner_id: string; role: Role; created_at: number }
export type Job = {
  id: string; board_id: string; user_id: string; provider: Provider; prompt: string
  parent_shape_id: string | null; status: string; result_json: string | null
  error: string | null; created_at: number; updated_at: number
}

function passwordDigest(password: string, salt: string): string {
  return scryptSync(password, Buffer.from(salt, 'hex'), 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }).toString('hex')
}

export function createUser(username: string, password: string): User {
  const name = username.trim().toLowerCase()
  if (!userNamePattern.test(name) || password.length < 12 || password.length > 128) {
    throw new Error('Username must be 3-32 letters/numbers; password must be 12-128 characters.')
  }
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)')
    .run(id, name, salt + ':' + passwordDigest(password, salt), now())
  return { id, username: name }
}

export function verifyLogin(username: string, password: string): User | null {
  if (typeof username !== 'string' || typeof password !== 'string' ||
      username.length > 64 || password.length > 128) return null
  const record = db.prepare('SELECT * FROM users WHERE username=?')
    .get(username.trim().toLowerCase()) as (User & { password_hash: string }) | undefined
  const [salt, expected] = (record?.password_hash ||
    '00000000000000000000000000000000:' + '0'.repeat(128)).split(':')
  const received = passwordDigest(password, salt)
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex')) || !record) return null
  return { id: record.id, username: record.username }
}

export function createSession(userId: string): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(sha256(token), userId, now() + 30 * 86400_000)
  return token
}

export function clearSession(token: string | null): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token))
}

export function extractSessionToken(header: string | undefined): string | null {
  const prefix = COOKIE_NAME + '='
  const cookie = (header || '').split(';').map(c => c.trim()).find(c => c.startsWith(prefix))
  const token = cookie?.slice(prefix.length)
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
}

export function resolveSession(header: string | undefined): User | null {
  const token = extractSessionToken(header)
  if (!token) return null
  return db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?')
    .get(sha256(token), now()) as User | undefined || null
}

export function makeBoard(userId: string, title: string): Board {
  const id = randomUUID()
  const name = title.trim().slice(0, 120)
  if (!name) throw new Error('Board title is required.')
  const timestamp = now()
  db.transaction(() => {
    db.prepare('INSERT INTO boards(id,owner_id,title,created_at) VALUES(?,?,?,?)')
      .run(id, userId, name, timestamp)
    db.prepare('INSERT INTO members(board_id,user_id,role) VALUES(?,?,?)').run(id, userId, 'owner')
  })()
  return { id, title: name, owner_id: userId, role: 'owner', created_at: timestamp }
}

export function listBoards(userId: string): Board[] {
  return db.prepare('SELECT b.*,m.role FROM boards b JOIN members m ON m.board_id=b.id WHERE m.user_id=? ORDER BY b.created_at DESC')
    .all(userId) as Board[]
}

export function boardAccess(userId: string, boardId: string): Role | null {
  const row = db.prepare('SELECT role FROM members WHERE board_id=? AND user_id=?')
    .get(boardId, userId) as { role: Role } | undefined
  return row?.role || null
}

export function getBoard(userId: string, boardId: string): Board | null {
  return db.prepare('SELECT b.*,m.role FROM boards b JOIN members m ON m.board_id=b.id WHERE b.id=? AND m.user_id=?')
    .get(boardId, userId) as Board | undefined || null
}

export function createInvite(boardId: string, role: 'editor' | 'viewer'): { id: string; token: string; expires_at: number } {
  const id = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const expires_at = now() + 7 * 86400_000
  db.prepare('INSERT INTO invitations(id,board_id,token_hash,role,expires_at) VALUES(?,?,?,?,?)')
    .run(id, boardId, sha256(token), role, expires_at)
  return { id, token, expires_at }
}

export function redeemInvite(boardId: string, userId: string, token: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false
  const invite = db.prepare('SELECT role FROM invitations WHERE board_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?')
    .get(boardId, sha256(token), now()) as { role: Role } | undefined
  if (!invite) return false
  db.prepare('INSERT INTO members(board_id,user_id,role) VALUES(?,?,?) ON CONFLICT(board_id,user_id) DO NOTHING')
    .run(boardId, userId, invite.role)
  return true
}

export function listInvites(boardId: string) {
  return db.prepare('SELECT id,role,expires_at,revoked_at FROM invitations WHERE board_id=? ORDER BY expires_at DESC')
    .all(boardId)
}

export function revokeInvite(boardId: string, invitationId: string): void {
  db.prepare('UPDATE invitations SET revoked_at=? WHERE board_id=? AND id=?')
    .run(now(), boardId, invitationId)
}

export function listMembers(boardId: string) {
  return db.prepare('SELECT u.id,u.username,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.board_id=? ORDER BY m.role,u.username')
    .all(boardId)
}

export function removeMember(boardId: string, userId: string): void {
  db.prepare("DELETE FROM members WHERE board_id=? AND user_id=? AND role!='owner'").run(boardId, userId)
}

export function addJob(userId: string, boardId: string, provider: Provider, prompt: string, parentShapeId: string | null): Job {
  const id = randomUUID()
  const timestamp = now()
  db.prepare('INSERT INTO research_jobs(id,board_id,user_id,provider,prompt,parent_shape_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, boardId, userId, provider, prompt, parentShapeId, 'queued', timestamp, timestamp)
  return getJob(id)!
}

export function getJob(id: string): Job | null {
  return db.prepare('SELECT * FROM research_jobs WHERE id=?').get(id) as Job | undefined || null
}

export function jobsForBoard(boardId: string): Job[] {
  return db.prepare('SELECT * FROM research_jobs WHERE board_id=? ORDER BY created_at DESC LIMIT 100')
    .all(boardId) as Job[]
}

export function updateJob(id: string, status: string, result: unknown = null, error: string | null = null): void {
  db.prepare('UPDATE research_jobs SET status=?,result_json=?,error=?,updated_at=? WHERE id=?')
    .run(status, result == null ? null : JSON.stringify(result).slice(0, 128000), error?.slice(0, 400) || null, now(), id)
}

// Interrupted work must not silently appear to have succeeded after a process restart.
db.prepare("UPDATE research_jobs SET status='interrupted',error='Server restarted during research',updated_at=? WHERE status IN ('queued','running')")
  .run(now())
