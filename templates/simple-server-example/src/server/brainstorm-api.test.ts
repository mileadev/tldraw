import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fastify from 'fastify'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('./brainstorm-research', () => ({ enqueueResearch: vi.fn() }))
const dir = mkdtempSync(join(tmpdir(), 'boards-'))
process.env.BRAINSTORM_DATA_DIR = dir
const { registerBrainstormRoutes } = await import('./brainstorm-api')
const {
	createUser,
	createSession,
	makeBoard,
	createInvite,
	redeemInvite,
	db,
	addJob,
	COOKIE_NAME,
} = await import('./brainstorm-db')
const { enqueueResearch } = await import('./brainstorm-research')
const app = fastify()
registerBrainstormRoutes(app)
afterAll(async () => {
	await app.close()
	db.close()
	rmSync(dir, { recursive: true, force: true })
})
const owner = createUser('owner', 'correct-horse-battery')
const editor = createUser('editor', 'correct-horse-battery')
const viewer = createUser('viewer', 'correct-horse-battery')
const stranger = createUser('stranger', 'correct-horse-battery')
const board = makeBoard(owner.id, 'Private research')
const other = makeBoard(stranger.id, 'Other private board')
for (const [user, role] of [
	[editor, 'editor'],
	[viewer, 'viewer'],
] as const)
	redeemInvite(board.id, user.id, createInvite(board.id, role).token)
const headers = (user: { id: string }) => ({ cookie: COOKIE_NAME + '=' + createSession(user.id) })
const endpoint = '/api/brainstorm/boards/' + board.id
const request = { provider: 'openai', prompt: 'private prompt', parentShapeId: null }
describe('Board authorization', () => {
	it('denies private board and job reads to anonymous and uninvited users', async () => {
		for (const user of [null, stranger])
			for (const suffix of ['', '/research']) {
				const response = await app.inject({
					url: endpoint + suffix,
					headers: user ? headers(user) : {},
				})
				expect(response.statusCode).toBe(404)
				expect(response.body).not.toContain('private prompt')
			}
	})
	it('allows owner/editor research and denies viewer/stranger/anonymous mutations', async () => {
		vi.mocked(enqueueResearch).mockClear()
		for (const user of [owner, editor])
			expect(
				(
					await app.inject({
						method: 'POST',
						url: endpoint + '/research',
						headers: headers(user),
						payload: request,
					})
				).statusCode
			).toBe(202)
		for (const user of [viewer, stranger, null])
			expect(
				(
					await app.inject({
						method: 'POST',
						url: endpoint + '/research',
						headers: user ? headers(user) : {},
						payload: request,
					})
				).statusCode
			).toBe(403)
		expect(enqueueResearch).toHaveBeenCalledTimes(2)
	})
	it('allows collaborators to read this board, never another board', async () => {
		addJob(stranger.id, other.id, 'web', 'other-board-secret', null)
		const response = await app.inject({ url: endpoint + '/research', headers: headers(editor) })
		expect(response.statusCode).toBe(200)
		expect(response.body).not.toContain('other-board-secret')
		expect(
			(
				await app.inject({
					url: '/api/brainstorm/boards/' + other.id + '/research',
					headers: headers(editor),
				})
			).statusCode
		).toBe(404)
	})
	it('rejects cross-origin research creation', async () => {
		expect(
			(
				await app.inject({
					method: 'POST',
					url: endpoint + '/research',
					headers: { ...headers(owner), origin: 'https://attacker.invalid' },
					payload: request,
				})
			).statusCode
		).toBe(403)
	})
	it('rejects expired and revoked invitations', async () => {
		for (const column of ['expires_at', 'revoked_at']) {
			const invite = createInvite(board.id, 'editor')
			db.prepare('UPDATE invitations SET ' + column + '=1 WHERE id=?').run(invite.id)
			expect(redeemInvite(board.id, stranger.id, invite.token)).toBe(false)
		}
	})
	it('only lets owners revoke membership and immediately removes HTTP access', async () => {
		const path = endpoint + '/members/' + editor.id
		expect(
			(await app.inject({ method: 'DELETE', url: path, headers: headers(viewer) })).statusCode
		).toBe(403)
		expect(
			(await app.inject({ method: 'DELETE', url: path, headers: headers(owner) })).statusCode
		).toBe(200)
		expect(
			(await app.inject({ url: endpoint + '/research', headers: headers(editor) })).statusCode
		).toBe(404)
	})
})
