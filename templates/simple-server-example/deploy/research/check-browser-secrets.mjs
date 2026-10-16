import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../src/client/dist/', import.meta.url))
const forbidden = [
	'BUILD_LEAK_SENTINEL_',
	...Object.entries(process.env)
		.filter(
			([name, value]) =>
				value &&
				/^(OPENAI_API_KEY|GEMINI_API_KEY|MISTRAL_API_KEY|TAVILY_API_KEY|RESEARCH_.*SECRET)$/.test(
					name
				)
		)
		.map(([, value]) => value),
]
let count = 0
async function scan(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = directory + '/' + entry.name
		if (entry.isDirectory()) {
			await scan(path)
			continue
		}
		const bytes = await readFile(path)
		if (forbidden.some((value) => bytes.includes(value)))
			throw new Error('Credential marker found in browser artifact: ' + path)
		count++
	}
}
await scan(root)
if (!count) throw new Error('No browser artifacts found')
console.log('PASS: browser artifacts contain no supplied credential values or test markers')
