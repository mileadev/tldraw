import websocketPlugin from '@fastify/websocket'
import fastify from 'fastify'
import type { RawData } from 'ws'
import { registerBrainstormRoutes } from './brainstorm-api'
import { boardAccess, idPattern, resolveSession } from './brainstorm-db'
import { makeOrLoadRoom } from './rooms'

const PORT = Number(process.env.PORT || 5858)
const app = fastify({ bodyLimit: 16384 })
app.register(websocketPlugin)
registerBrainstormRoutes(app)

app.register(async app => {
  app.get('/connect/:roomId', { websocket: true }, async (socket, req) => {
    const roomId = (req.params as { roomId: string }).roomId
    let readonly = false
    if (idPattern.test(roomId)) {
      const user = resolveSession(req.headers.cookie)
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

    // Preserve frames received while the room is being opened.
    const caughtMessages: RawData[] = []
    const collect = (message: RawData) => {
      if (caughtMessages.length >= 100 || caughtMessages.reduce((n, v) => n + v.length, 0) > 1048576) {
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

app.listen({ host: process.env.HOST || '127.0.0.1', port: PORT }, err => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log('Brainstorm server listening on port ' + PORT)
})
