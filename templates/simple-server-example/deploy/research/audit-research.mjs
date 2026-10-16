import { spawnSync } from 'node:child_process'

const result = spawnSync('pnpm', ['audit', '--prod', '--json'], {
	cwd: new URL('../../../../', import.meta.url),
	encoding: 'utf8',
	timeout: 120000,
	maxBuffer: 16 * 1024 * 1024,
})
if (result.error || ![0, 1].includes(result.status))
	throw new Error('Dependency audit could not complete')
const report = JSON.parse(result.stdout)
if (!report.advisories || !report.metadata?.vulnerabilities || report.error)
	throw new Error('Invalid dependency audit response')
const relevant = Object.values(report.advisories).filter((advisory) =>
	advisory.findings?.some((finding) =>
		finding.paths?.some((path) => path.includes('templates__simple-server-example>'))
	)
)
for (const advisory of relevant)
	console.error(advisory.severity + ': ' + advisory.module_name + ' — ' + advisory.url)
console.log('Research template dependency advisories: ' + relevant.length)
console.log('Repository-wide advisory counts: ' + JSON.stringify(report.metadata.vulnerabilities))
if (relevant.length) process.exitCode = 1
