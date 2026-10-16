import websocketPlugin from '@fastify/websocket'
import fastify from 'fastify'
import type { RawData } from 'ws'
import { registerBrainstormRoutes } from './brainstorm-api'
import { boardAccess, idPattern, resolveSession } from './brainstorm-db'
import { trackBoardSocket } from './connections'
import { makeOrLoadRoom } from './rooms'

export function createBrainstormServer() {
	const app = fastify({ bodyLimit: 16384 })
	const trustedClientIp = process.env.BRAINSTORM_TRUSTED_CLIENT_IP
	if (process.env.NODE_ENV === 'production' && !trustedClientIp)
		throw new Error('Production API requires an ingress client IP')
	app.addHook('onRequest', async (req, reply) => {
		// Use the socket address, never forwarded headers: provider networks are not API clients.
		if (trustedClientIp && req.raw.socket.remoteAddress !== trustedClientIp)
			return reply.code(403).send({ error: 'Ingress denied' })
	})
	app.register(websocketPlugin)
	registerBrainstormRoutes(app)

	app.register(async (app) => {
		app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
			const roomId = (req.params as { roomId: string }).roomId
			const user = idPattern.test(roomId) ? resolveSession(req.headers.cookie) : null
			let readonly = false
			if (idPattern.test(roomId)) {
				const role = user && boardAccess(user.id, roomId)
				if (!role) {
					socket.close(1008, 'Board access denied')
					return
				}
				readonly = role === 'viewer'
			} else if (process.env.ALLOW_LEGACY_PUBLIC_ROOMS !== 'true') {
				socket.close(1008, 'Unknown board')
				return
			}

			const sessionId = (req.query as { sessionId?: string }).sessionId
			if (typeof sessionId !== 'string' || sessionId.length > 128 || !sessionId) {
				socket.close(1008, 'Invalid session')
				return
			}

			// Track the live socket so removing a board member closes it immediately.
			const unregister = trackBoardSocket(socket, roomId, user?.id ?? null)
			socket.on('close', unregister)

			// Preserve frames received while the room is being opened.
			const caughtMessages: RawData[] = []
			let bufferedBytes = 0
			const collect = (message: RawData) => {
				bufferedBytes += Array.isArray(message)
					? message.reduce((sum, buffer) => sum + buffer.byteLength, 0)
					: message.byteLength
				if (caughtMessages.length >= 100 || bufferedBytes > 1048576) {
					socket.close(1009, 'Connection buffer exceeded')
					return
				}
				caughtMessages.push(message)
			}
			socket.on('message', collect)
			try {
				const room = makeOrLoadRoom(roomId)
				room.handleSocketConnect({ sessionId, socket, isReadonly: readonly })
				socket.off('message', collect)
				for (const message of caughtMessages) socket.emit('message', message)
			} catch (error) {
				req.log.error(error, 'Room connection failed')
				socket.close(1011, 'Room error')
			}
		})

		// Reject unscoped uploads and remote URL unfurling until scoped asset storage exists.
		app.put('/uploads/:id', async (_, reply) => reply.code(403).send({ error: 'Uploads disabled' }))
		app.get('/uploads/:id', async (_, reply) => reply.code(403).send({ error: 'Uploads disabled' }))
		app.get('/unfurl', async (_, reply) => reply.code(403).send({ error: 'Unfurling disabled' }))
	})

	return app
}
