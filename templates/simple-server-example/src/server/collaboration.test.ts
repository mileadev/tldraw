import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTlsyncProtocolVersion } from '@tldraw/sync-core'
import { afterAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

vi.mock('./brainstorm-research', () => ({ enqueueResearch: vi.fn() }))
const dir = mkdtempSync(join(tmpdir(), 'collaboration-'))
process.env.BRAINSTORM_DATA_DIR = join(dir, 'metadata')
process.env.BRAINSTORM_ROOMS_DIR = join(dir, 'rooms')
const { createBrainstormServer } = await import('./server-app')
const { makeOrLoadRoom } = await import('./rooms')
const { db, createUser, createSession, createInvite, redeemInvite, makeBoard, COOKIE_NAME } =
	await import('./brainstorm-db')
const app = createBrainstormServer()
const origin = await app.listen({ host: '127.0.0.1', port: 0 })
const url = origin.replace('http:', 'ws:')
const owner = createUser('owner', 'correct-horse-battery')
const viewer = createUser('viewer', 'correct-horse-battery')
const editor = createUser('editor', 'correct-horse-battery')
const stranger = createUser('stranger', 'correct-horse-battery')
const board = makeBoard(owner.id, 'Private collaboration')
for (const [user, role] of [
	[viewer, 'viewer'],
	[editor, 'editor'],
] as const)
	redeemInvite(board.id, user.id, createInvite(board.id, role).token)
const sockets: WebSocket[] = []
const cookie = (user: { id: string }) => COOKIE_NAME + '=' + createSession(user.id)
function connect(user: { id: string } | null, session: string, boardId = board.id) {
	const socket = new WebSocket(url + '/connect/' + boardId + '?sessionId=' + session, {
		headers: user ? { cookie: cookie(user) } : {},
	})
	sockets.push(socket)
	return socket
}
async function handshake(socket: WebSocket, session: string) {
	await once(socket, 'open')
	const room = makeOrLoadRoom(board.id)
	const response = once(socket, 'message')
	socket.send(
		JSON.stringify({
			type: 'connect',
			connectRequestId: session,
			lastServerClock: 0,
			protocolVersion: getTlsyncProtocolVersion(),
			schema: room.storage.getSnapshot!().schema,
		})
	)
	const [data] = await response
	expect(JSON.parse(data.toString()).type).toBe('connect')
	return room
}
afterAll(async () => {
	for (const socket of sockets)
		if (socket.readyState !== WebSocket.CLOSED) {
			const closed = once(socket, 'close')
			socket.close()
			await closed
		}
	await app.close()
	db.close()
	rmSync(dir, { recursive: true, force: true })
})
describe('Live collaboration boundary', () => {
	it('denies anonymous, uninvited, and legacy public room connections', async () => {
		for (const [user, room] of [
			[null, board.id],
			[stranger, board.id],
			[null, 'public-room'],
		] as const) {
			const socket = connect(user, 'denied', room)
			const [code] = await once(socket, 'close')
			expect(code).toBe(1008)
		}
	})
	it('allows editor changes, distributes them to viewers, and rejects forged viewer writes', async () => {
		const editorSocket = connect(editor, 'editor-session')
		const room = await handshake(editorSocket, 'editor-session')
		const viewerSocket = connect(viewer, 'viewer-session')
		await handshake(viewerSocket, 'viewer-session')
		expect(room.getSessions().find((s) => s.sessionId === 'viewer-session')?.isReadonly).toBe(true)
		const page = {
			id: 'page:test',
			typeName: 'page',
			name: 'Collaborative page',
			index: 'a1',
			meta: {},
		}
		const broadcast = once(viewerSocket, 'message')
		editorSocket.send(
			JSON.stringify({ type: 'push', clientClock: 1, diff: { [page.id]: ['put', page] } })
		)
		await broadcast
		await vi.waitFor(() =>
			expect(room.storage.getSnapshot!().documents.some((d) => d.state.id === page.id)).toBe(true)
		)
		viewerSocket.send(
			JSON.stringify({
				type: 'push',
				clientClock: 1,
				diff: { 'page:forged': ['put', { ...page, id: 'page:forged' }] },
			})
		)
		// A ping acts as a barrier: the preceding mutation frame has been processed.
		const pong = once(viewerSocket, 'pong')
		viewerSocket.ping()
		await pong
		expect(room.storage.getSnapshot!().documents.some((d) => d.state.id === 'page:forged')).toBe(
			false
		)
	})
	it('closes revoked members immediately and denies their reconnect', async () => {
		const socket = sockets.find((s) => s.readyState === WebSocket.OPEN)!
		const closed = once(socket, 'close')
		const result = await app.inject({
			method: 'DELETE',
			url: '/api/brainstorm/boards/' + board.id + '/members/' + editor.id,
			headers: { cookie: cookie(owner) },
		})
		expect(result.statusCode).toBe(200)
		expect((await closed)[0]).toBe(1008)
		expect((await once(connect(editor, 'reconnect'), 'close'))[0]).toBe(1008)
	})
})

it('denies provider-network API requests even with forged forwarded headers', async () => {
	process.env.BRAINSTORM_TRUSTED_CLIENT_IP = '172.31.240.2'
	const restricted = createBrainstormServer()
	delete process.env.BRAINSTORM_TRUSTED_CLIENT_IP
	try {
		const response = await restricted.inject({
			method: 'POST',
			url: '/api/brainstorm/auth/register',
			remoteAddress: '172.30.0.9',
			headers: { 'x-forwarded-for': '172.31.240.2' },
			payload: { username: 'bypass', password: 'correct-horse-battery' },
		})
		expect(response.statusCode).toBe(403)
		expect(response.json()).toEqual({ error: 'Ingress denied' })
		expect(
			(await restricted.inject({ url: '/api/brainstorm/me', remoteAddress: '172.31.240.2' }))
				.statusCode
		).toBe(401)
	} finally {
		await restricted.close()
	}
})
