import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { API_HOSTS, PROVIDERS } from './research-config'
const compose = JSON.parse(
	readFileSync(new URL('../../compose.research.json', import.meta.url), 'utf8')
)
describe('Deployment contract', () => {
	it.each(PROVIDERS)('restricts %s to its own network and secret mounts', (provider) => {
		const worker = compose.services['research-' + provider]
		expect(worker.networks).toEqual([provider])
		expect(compose.networks[provider].internal).toBe(true)
		expect(worker.secrets).toEqual([provider + '-worker-token', provider + '-api-key'])
		expect(worker.ports).toBeUndefined()
		expect(worker.environment.PROVIDER).toBe(provider)
		expect(worker.environment.RESEARCH_EGRESS_PROXY).toBe('http://egress-' + provider + ':3128')
		expect(Object.keys(worker.environment).filter((k) => k.endsWith('API_KEY'))).toEqual([])
		const proxy = compose.services['egress-' + provider]
		expect(proxy.networks).toEqual([provider, provider + '-egress'])
		expect(proxy.secrets).toBeUndefined()
		expect(proxy.ports).toBeUndefined()
		const policy = readFileSync(
			new URL('../../deploy/research/' + provider + '.squid.conf', import.meta.url),
			'utf8'
		)
		expect(policy).toContain('acl provider dstdomain -n ' + API_HOSTS[provider] + '\n')
		expect(policy.indexOf('http_access deny private')).toBeLessThan(
			policy.indexOf('http_access allow provider')
		)
		expect(policy).toContain(
			'http_access deny !CONNECT\nhttp_access deny !TLS_port\nhttp_access deny !provider'
		)
		expect(policy).toContain('http_access deny all')
	})
	it('drops runtime privileges and bounds resources for every service', () => {
		for (const service of Object.values(compose.services) as any[]) {
			expect(service.user).toBe('10001:10001')
			expect(service.read_only).toBe(true)
			expect(service.cap_drop).toEqual(['ALL'])
			expect(service.security_opt).toContain('no-new-privileges:true')
			expect(service.pids_limit).toBe(64)
			expect(service.cpus).toBeGreaterThan(0)
			expect(service.mem_limit).toMatch(/^[1-9]\d*m$/)
			expect(service.privileged).toBeUndefined()
			expect(service.network_mode).toBeUndefined()
			expect(JSON.stringify(service.volumes || [])).not.toContain('docker.sock')
		}
	})
	it('keeps upstream credentials out of the API container', () => {
		expect(compose.services.api.secrets).toEqual(PROVIDERS.map((p) => p + '-worker-token'))
		expect(compose.services.api.ports).toBeUndefined()
		expect(compose.services.ingress.ports).toEqual(['127.0.0.1:5858:8080'])
		expect(compose.services.api.environment.BRAINSTORM_TRUSTED_CLIENT_IP).toBe(
			compose.services.ingress.networks.ingress.ipv4_address
		)
	})
})

it('reserves distinct ingress addresses and prevents external DNS forwarding', () => {
	expect(compose.services.api.networks.ingress.ipv4_address).toBe('172.31.240.3')
	for (const name of ['api', 'ingress', ...PROVIDERS.map((p) => 'research-' + p)])
		expect(compose.services[name].dns).toEqual(['127.0.0.1'])
})
