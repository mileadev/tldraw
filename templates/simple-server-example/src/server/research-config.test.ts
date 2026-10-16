import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { workerConfig, workerEndpoints } from './research-config'

const dir = mkdtempSync(join(tmpdir(), 'research-config-'))
const keyFile = join(dir, 'key')
const tokenFile = join(dir, 'token')
writeFileSync(keyFile, 'private-provider-key\n', { mode: 0o600 })
writeFileSync(tokenFile, 'private-worker-token\n', { mode: 0o600 })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const env = {
	PROVIDER: 'openai',
	OPENAI_API_KEY_FILE: keyFile,
	RESEARCH_WORKER_SECRET_FILE: tokenFile,
	RESEARCH_EGRESS_PROXY: 'http://egress-openai:3128',
}
describe('Fail-closed configuration', () => {
	it('loads only file-mounted secrets', () =>
		expect(workerConfig(env)).toEqual({
			provider: 'openai',
			key: 'private-provider-key',
			secret: 'private-worker-token',
			proxy: 'http://egress-openai:3128/',
		}))
	it.each([
		{ PROVIDER: '' },
		{ PROVIDER: 'openai,gemini' },
		{ OPENAI_API_KEY: 'inline' },
		{ GEMINI_API_KEY_FILE: keyFile },
		{ GEMINI_API_KEY: 'foreign' },
		{ RESEARCH_WORKER_SECRET_FILE: '' },
		{ RESEARCH_EGRESS_PROXY: '' },
		{ RESEARCH_EGRESS_PROXY: 'http://user:password@proxy' },
	])('rejects ambiguous or incomplete settings %j', (invalid) =>
		expect(() => workerConfig({ ...env, ...invalid })).toThrow()
	)
	it('rejects short and multiline secrets', () => {
		const file = join(dir, 'bad')
		for (const key of ['short', 'long-credential\nsecond-line']) {
			writeFileSync(file, key)
			expect(() => workerConfig({ ...env, OPENAI_API_KEY_FILE: file })).toThrow()
		}
	})
	it('does not fall back to a shared worker', () => {
		expect(
			workerEndpoints({
				RESEARCH_WORKER_URL: 'http://old:5860',
				RESEARCH_WORKER_SECRET: 'old-secret',
			})
		).toEqual({})
		expect(() => workerEndpoints({ RESEARCH_WORKER_URLS: '{bad' })).toThrow()
		expect(() => workerEndpoints({ RESEARCH_WORKER_URLS: '{"openai":"http://worker"}' })).toThrow()
	})
	it('requires a separate token for each configured endpoint', () => {
		expect(
			workerEndpoints({
				RESEARCH_WORKER_URLS: '{"openai":"http://research-openai:5860"}',
				RESEARCH_OPENAI_SECRET_FILE: tokenFile,
			})
		).toEqual({ openai: { url: 'http://research-openai:5860', secret: 'private-worker-token' } })
	})
	it.each([
		'[]',
		'{"unknown":"http://worker"}',
		'{"openai":"file:///tmp/key"}',
		'{"openai":"http://worker/path"}',
		'{"openai":"http://secret@worker"}',
	])('rejects worker mapping %s', (mapping) =>
		expect(() => workerEndpoints({ RESEARCH_WORKER_URLS: mapping })).toThrow()
	)
})
