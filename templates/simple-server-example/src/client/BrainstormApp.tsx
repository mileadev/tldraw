import { useEffect, useState } from 'react'
import { useSync } from '@tldraw/sync'
import { createShapeId, Editor, TLShapeId, Tldraw, toRichText, inlineBase64AssetStore } from 'tldraw'

type Board = { id: string; title: string; role: 'owner'|'editor'|'viewer' }
type Finding = { title: string; summary: string; sources: { title: string; url: string }[] }
type Job = { id: string; provider: string; prompt: string; status: string; parent_shape_id: string|null; result_json: string|null; error: string|null }
type User = { id: string; username: string }
const api = async (path: string, init?: RequestInit) => {
  const result = await fetch('/api/brainstorm/' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init
  })
  const body = await result.json()
  if (!result.ok) throw new Error(body.error || 'Request failed')
  return body
}
const post = (p: string, data: unknown) => api(p, { method: 'POST', body: JSON.stringify(data) })
const toId = (s: string) => createShapeId(s)
const safeUrl = (s: string) => { try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) ? u.href : '#' } catch { return '#' } }

function Canvas({ board }: { board: Board }) {
  const store = useSync({ uri: location.origin.replace(/^http/, 'ws') + '/connect/' + board.id, assets: inlineBase64AssetStore })
  const [editor, setEditor] = useState<Editor | null>(null)
  const [text, setText] = useState('')
  const [provider, setProvider] = useState<'openai'|'gemini'|'mistral'>('openai')
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [share, setShare] = useState('')
  const [autoPinned, setAutoPinned] = useState<Set<string>>(new Set())
  const writable = board.role !== 'viewer'

  useEffect(() => {
    let alive = true
    const poll = () => api('boards/' + board.id + '/research')
      .then(d => { if (alive) setJobs(d.jobs) }).catch(e => { if (alive) setError(e.message) })
    void poll()
    const interval = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(interval) }
  }, [board.id])

  function addNode(value: string, parent?: TLShapeId | null, id?: TLShapeId) {
    if (!editor || !writable || !value.trim()) return
    const shapeId = id || createShapeId()
    if (editor.getShape(shapeId)) return
    const anchor = parent ? editor.getShape(parent) : null
    const pos = anchor ? { x: anchor.x + 330, y: anchor.y + 80 + Math.random() * 80 } :
      { x: editor.getViewportPageBounds().center.x, y: editor.getViewportPageBounds().center.y }
    editor.createShape({ id: shapeId, type: 'geo', x: pos.x, y: pos.y, props: { geo: 'rectangle', w: 260, h: 110, richText: toRichText(value.slice(0, 2000)), align: 'middle', verticalAlign: 'middle' } })
    if (anchor) {
      const arrowId = createShapeId()
      editor.createShape({ id: arrowId, type: 'arrow', x: anchor.x + 260, y: anchor.y + 55,
        props: { start: { x: 0, y: 0 }, end: { x: pos.x - anchor.x - 260, y: pos.y - anchor.y } } })
      editor.createBindings([
        { type: 'arrow', fromId: arrowId, toId: anchor.id, props: {
          terminal: 'start', normalizedAnchor: { x: .5, y: .5 }, isPrecise: false, isExact: false
        } },
        { type: 'arrow', fromId: arrowId, toId: shapeId, props: {
          terminal: 'end', normalizedAnchor: { x: .5, y: .5 }, isPrecise: false, isExact: false
        } }
      ])
    }
    editor.select(shapeId)
  }

  useEffect(() => {
    if (!editor || !writable) return
    for (const job of jobs.filter(j => j.status === 'completed' && j.result_json)) {
      if (autoPinned.has(job.id)) continue
      try {
        const result = JSON.parse(job.result_json!) as { summary: string; findings: Finding[] }
        result.findings?.forEach((finding, index) => {
          // Stable IDs ensure multiple clients never duplicate a research node.
          const id = toId('research_' + job.id.replaceAll('-', '_') + '_' + index)
          const label = finding.title + '\n' + finding.summary.slice(0, 600)
          addNode(label, job.parent_shape_id as TLShapeId | null, id)
        })
        setAutoPinned(prev => new Set(prev).add(job.id))
      } catch { setError('Could not parse research result') }
    }
  }, [jobs, editor, writable, autoPinned])

  async function research() {
    if (!text.trim() || !writable) return
    try {
      setError('')
      const selected = editor?.getSelectedShapeIds()[0] || null
      await post('boards/' + board.id + '/research', { provider, prompt: text, parentShapeId: selected })
      setText('')
    } catch (e) { setError((e as Error).message) }
  }
  async function invite(role: 'editor'|'viewer') {
    try {
      const data = await post('boards/' + board.id + '/invites', { role })
      setShare(location.origin + '/?board=' + board.id + '&invite=' + data.invite.token)
    } catch (e) { setError((e as Error).message) }
  }
  return <div className="canvas-shell">
    <div className="canvas"><Tldraw store={store} onMount={setEditor} /></div>
    <aside className="sidebar">
      <h2>{board.title}</h2><small>{board.role} · Live collaboration</small>
      <label>Brainstorm</label>
      <textarea disabled={!writable} value={text} onChange={e => setText(e.target.value)}
        placeholder="Enter an idea, question, or research objective..." rows={5} />
      <div className="actions">
        <button disabled={!writable || !text.trim()} onClick={() => { addNode(text, editor?.getSelectedShapeIds()[0]); setText('') }}>Pin node</button>
        <button disabled={!writable || !text.trim()} onClick={() => { addNode(text, null); setText('') }}>Pin root</button>
      </div>
      <label>Deep research</label>
      <select value={provider} onChange={e => setProvider(e.target.value as typeof provider)}>
        <option value="openai">OpenAI web research</option>
        <option value="gemini">Gemini grounded research</option>
        <option value="mistral">Mistral (model knowledge)</option>
      </select>
      <button disabled={!writable || !text.trim()} onClick={research}>Launch research</button>
      <small>Select an existing canvas shape first to attach a subnode. Double-click a node to edit its text.</small>
      {board.role === 'owner' && <>
        <label>Invite collaborators</label>
        <div className="actions">
          <button onClick={() => invite('editor')}>Editor link</button>
          <button onClick={() => invite('viewer')}>Viewer link</button>
        </div>
        {share && <input readOnly value={share} onFocus={e => e.target.select()} />}
      </>}
      <h3>Research jobs</h3>
      <div className="job-list">{jobs.map(job => {
        let findings: Finding[] = []
        try { findings = JSON.parse(job.result_json || '{}').findings || [] } catch { /* Failed research remains visible */ }
        return <article key={job.id}>
          <strong>{job.provider} · {job.status}</strong><p>{job.prompt}</p>
          {job.error && <small>{job.error}</small>}
          {findings.map((f, index) => <details key={index}><summary>{f.title}</summary>
            <p>{f.summary}</p>
            {f.sources.map((s, n) => <div key={n}><a href={safeUrl(s.url)} rel="noopener noreferrer" target="_blank">{s.title}</a></div>)}
          </details>)}
        </article>
      })}</div>
      {error && <p role="alert">{error}</p>}
    </aside>
  </div>
}
export default function BrainstormApp() {
  const [user, setUser] = useState<User | null>(null)
  const [boards, setBoards] = useState<Board[]>([])
  const [board, setBoard] = useState<Board | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [isNew, setIsNew] = useState(false)
  useEffect(() => { api('me').then(d => setUser(d.user)).catch(() => {}) }, [])
  useEffect(() => {
    if (!user) return
    const params = new URLSearchParams(location.search)
    const id = params.get('board'), token = params.get('invite')
    if (id && token) {
      void post('boards/' + id + '/join', { token }).then(d => {
        setBoard(d.board)
        history.replaceState(null, '', '/?board=' + id)
      }).catch(e => setError(e.message))
    } else if (id) {
      void api('boards/' + id).then(d => setBoard(d.board)).catch(e => setError(e.message))
    }
    void api('boards').then(d => setBoards(d.boards)).catch(e => setError(e.message))
  }, [user])
  async function auth() {
    try {
      const d = await post(isNew ? 'auth/register' : 'auth/login', { username, password })
      setUser(d.user)
      setPassword('')
    } catch (e) { setError((e as Error).message) }
  }
  async function create() {
    try {
      const d = await post('boards', { title })
      setBoard(d.board)
      history.replaceState(null, '', '/?board=' + d.board.id)
    } catch (e) { setError((e as Error).message) }
  }
  if (!user) return <main className="welcome"><h1>Research canvas</h1><p>Private mind maps and collaborative research.</p>
    <form onSubmit={e => { e.preventDefault(); void auth() }}>
      <input autoComplete="username" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required />
      <input autoComplete={isNew ? 'new-password' : 'current-password'} type="password" placeholder="Password (12+ characters)" value={password} onChange={e => setPassword(e.target.value)} required />
      <button type="submit">{isNew ? 'Create account' : 'Sign in'}</button>
    </form><button onClick={() => setIsNew(!isNew)}>{isNew ? 'Use existing account' : 'Create free account'}</button>
    {error && <p role="alert">{error}</p>}</main>
  return <><header className="top"><strong>Research canvas</strong><span>{user.username}</span>
    <button onClick={() => { setBoard(null); history.replaceState(null, '', '/'); void api('boards').then(d => setBoards(d.boards)) }}>Boards</button>
    <button onClick={async () => { await post('auth/logout', {}); setUser(null); setBoard(null) }}>Sign out</button>
  </header>{board ? <Canvas key={board.id} board={board} /> :
    <main className="welcome"><h1>Boards</h1><div className="actions"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="New board name" />
      <button onClick={create}>Create private board</button></div>
      {boards.map(b => <p key={b.id}><button onClick={() => { setBoard(b); history.replaceState(null, '', '/?board=' + b.id) }}>{b.title} · {b.role}</button></p>)}
      {error && <p role="alert">{error}</p>}</main>}</>
}
