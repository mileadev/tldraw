import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ getJob: vi.fn(), updateJob: vi.fn(), boardAccess: vi.fn() }))
vi.mock('./brainstorm-db', () => mock)
const dir = mkdtempSync(join(tmpdir(), 'dispatch-'))
const token = join(dir, 'token')
writeFileSync(token, 'worker-token-private-123', { mode: 0o600 })
process.env.RESEARCH_WORKER_URLS =
	'{"openai":"http://research-openai:5860","gemini":"http://research-gemini:5860"}'
const token2 = join(dir, 'token2')
writeFileSync(token2, 'gemini-worker-token-private-123', { mode: 0o600 })
process.env.RESEARCH_GEMINI_SECRET_FILE = token2
process.env.RESEARCH_OPENAI_SECRET_FILE = token
const { enqueueResearch } = await import('./brainstorm-research')
afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
	delete process.env.RESEARCH_WORKER_URLS
	delete process.env.RESEARCH_GEMINI_SECRET_FILE
	delete process.env.RESEARCH_OPENAI_SECRET_FILE
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})
const job = {
	id: 'job',
	provider: 'openai',
	board_id: 'board',
	user_id: 'user',
	prompt: 'private-board-prompt',
}
async function done() {
	await vi.waitFor(() =>
		expect(
			mock.updateJob.mock.calls.some(
				(call) => call[0] === 'job' && ['completed', 'failed'].includes(call[1])
			)
		).toBe(true)
	)
}
describe('Research dispatch', () => {
	it('does not send queued work after access is revoked', async () => {
		mock.getJob.mockReturnValue(job)
		mock.boardAccess.mockReturnValue(null)
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		enqueueResearch('job')
		await done()
		expect(fetch).not.toHaveBeenCalled()
	})
	it('routes only the minimal payload, never board/session identifiers', async () => {
		mock.getJob.mockReturnValue(job)
		mock.boardAccess.mockReturnValue('editor')
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ output: '{"summary":"ok","findings":[]}' })))
		vi.stubGlobal('fetch', fetch)
		enqueueResearch('job')
		await vi.waitFor(() =>
			expect(mock.updateJob).toHaveBeenCalledWith('job', 'completed', {
				summary: 'ok',
				findings: [],
			})
		)
		const [url, init] = fetch.mock.calls[0]
		expect(url).toBe('http://research-openai:5860/research')
		expect(JSON.parse(init.body)).toEqual({
			provider: 'openai',
			prompt: job.prompt,
			system: expect.any(String),
		})
		expect(init.headers.authorization).toBe('Bearer worker-token-private-123')
		expect(init.redirect).toBe('error')
	})
	it('fails a disabled provider without sending its prompt to a fallback', async () => {
		mock.getJob.mockReturnValue({ ...job, provider: 'web' })
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		enqueueResearch('job')
		await done()
		expect(fetch).not.toHaveBeenCalled()
	})
	it.each(['unavailable', 'malformed', 'timeout', 'too large'])(
		'fails safely on %s without storing an upstream secret',
		async (mode) => {
			mock.getJob.mockReturnValue(job)
			mock.boardAccess.mockReturnValue('owner')
			const fetch = vi.fn().mockImplementation(async () => {
				if (mode === 'timeout') throw new Error('worker-token-private-123')
				if (mode === 'unavailable') return new Response('provider-secret', { status: 502 })
				if (mode === 'too large') return new Response('x'.repeat(512001))
				return new Response('{"error":"worker-token-private-123"}')
			})
			vi.stubGlobal('fetch', fetch)
			enqueueResearch('job')
			await done()
			expect(mock.updateJob).toHaveBeenLastCalledWith(
				'job',
				'failed',
				null,
				'Research execution failed'
			)
		}
	)
	it('discards results if access is revoked during a provider request', async () => {
		mock.getJob.mockReturnValue(job)
		mock.boardAccess.mockReturnValueOnce('editor').mockReturnValue(null)
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"output":"{}"}')))
		enqueueResearch('job')
		await done()
		expect(mock.updateJob).not.toHaveBeenCalledWith('job', 'completed', expect.anything())
	})
})

it('serializes jobs for one provider while allowing a second provider to run', async () => {
	const jobs = {
		first: { ...job, id: 'first' },
		second: { ...job, id: 'second' },
		parallel: { ...job, id: 'parallel', provider: 'gemini' },
	}
	mock.getJob.mockImplementation((id: keyof typeof jobs) => jobs[id])
	mock.boardAccess.mockReturnValue('owner')
	const releases: (() => void)[] = []
	const fetch = vi
		.fn()
		.mockImplementation(
			() => new Promise((resolve) => releases.push(() => resolve(new Response('{"output":"{}"}'))))
		)
	vi.stubGlobal('fetch', fetch)
	enqueueResearch('first')
	enqueueResearch('second')
	enqueueResearch('parallel')
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
	expect(fetch.mock.calls.map(([url]) => url)).toEqual([
		'http://research-openai:5860/research',
		'http://research-gemini:5860/research',
	])
	releases[0]()
	releases[1]()
	await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
	releases[2]()
	await vi.waitFor(() =>
		expect(mock.updateJob.mock.calls.filter(([, status]) => status === 'completed')).toHaveLength(3)
	)
})
