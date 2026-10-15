import type { WebSocket } from 'ws'

// Live-socket registry for collaboration boards.
// Room access is re-checked on every new WebSocket connection, but an
// already-connected member would otherwise keep their session until they
// disconnect. Tracking live sockets lets membership changes (revocation) be
// enforced immediately by closing the affected sockets.
type Entry = { socket: WebSocket; roomId: string; userId: string | null }

const entries = new Set<Entry>()

/**
 * Register a live collaboration socket. Returns an unregister function that
 * must be called when the socket closes so the registry does not leak.
 */
export function trackBoardSocket(socket: WebSocket, roomId: string, userId: string | null): () => void {
	const entry: Entry = { socket, roomId, userId }
	entries.add(entry)
	return () => {
		entries.delete(entry)
	}
}

/**
 * Close live sockets for a board, optionally limited to a single user's
 * sockets. Called when a member is removed from a board; the next connection
 * attempt is denied by the regular access check.
 */
export function closeBoardSockets(roomId: string, userId?: string): void {
	for (const entry of entries) {
		if (entry.roomId !== roomId) continue
		if (userId && entry.userId !== userId) continue
		entries.delete(entry)
		entry.socket.close(1008, 'Board access revoked')
	}
}
