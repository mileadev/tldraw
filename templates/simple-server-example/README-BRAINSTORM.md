# Research canvas: deployment and verification

## Status and scope

An additive brainstorming feature is implemented in this tldraw fork under the existing simple-server example. It is a **development preview**, not a production-ready deployment. It includes account registration/login, private boards, editor/viewer invitation links, a shared tldraw canvas, editable shape labels, brainstorming input, asynchronous provider research, research history and structured source links.

Research providers are called through their APIs from a separately runnable worker process. **Mistral Vibe is a coding assistant, not an API-compatible web research endpoint**; the implementation uses the Mistral chat API as a model-only fallback, expressly not live-search grounded. OpenAI uses the Responses web_search tool. Gemini uses generateContent with google_search.

The existing demo server was changed to reject non-UUID legacy room IDs unless explicitly enabled with ALLOW_LEGACY_PUBLIC_ROOMS=true. Arbitrary uploads and URL unfurling are disabled to avoid unscoped assets and SSRF.

## Local prerequisites

- Node >= 22.12 and the repository's pinned pnpm from packageManager.
- A writable local persistent directory for SQLite and tldraw room snapshots.
- For cloud research, at least one provider credential; no credentials are bundled.

From repository root:

    corepack enable
    pnpm install --frozen-lockfile

Run the web/API process, browser UI and worker. Set secrets in the service manager, secret store, or ephemeral shell environment; do not commit them.

    export RESEARCH_WORKER_SECRET="<random-32+-byte-secret>"
    export OPENAI_API_KEY="<OpenAI-key>"
    export GEMINI_API_KEY="<Gemini-key>"
    export MISTRAL_API_KEY="<Mistral-key>"
    pnpm --filter @tldraw/simple-server-example dev-brainstorm

Open http://localhost:5757. API runs on 127.0.0.1:5858 (Vite proxies the /api/brainstorm and /connect routes); worker runs on port 5860. The service currently binds the worker to 0.0.0.0; put it inside a private network namespace/container or restrict it at the host firewall. No worker endpoint should be public. In production, route /api/brainstorm and /connect through a single TLS origin, and configure NODE_ENV=production for Secure cookies.

## Functionality

1. Create a free local account (username: 3-32 allowed characters; password: 12-128).
2. Create a private board.
3. Enter brainstorming text and click Pin root or Pin node. Select a shape to attach a relative subnode.
4. Double-click shape labels to edit. Move and arrange nodes with the native canvas.
5. Select OpenAI, Gemini, or Mistral and launch research; job statuses and findings appear in the sidebar.
6. The client attempts to convert structured research findings into persistent nodes. Source URLs are preserved in the research panel; they are not independently verified.
7. Owner can create an expiring editor/viewer link; collaborator signs in and opens the link to join. Only invited members can access the board.

## Known limitations (do not claim complete)

- Arrow connectors use tldraw arrow binding records and follow moved nodes. Automated hierarchical layout, collapse/expand and cycle detection are not yet implemented.
- Research containers: separate worker process exists, but hardened per-provider containers, egress policies, API budgets, and real browser extraction are not implemented.
- Provider result schema is best-effort: some responses will remain unstructured and must be reviewed.
- Research results are first consumed/pinned by an editor's browser, not by an authoritative server-side document writer. Competing clients could race. Stable shape IDs reduce duplication but are not a full transactional guarantee.
- Existing open WebSocket sessions do not yet get forcibly disconnected when membership is revoked.
- Existing SQLite tldraw rooms and brainstorm.sqlite are separate storage systems. Implement coordinated encrypted backups.
- No account email verification, password-reset workflow, identity-provider integration, audit UI, billing, object-storage support, or tenant-specific provider restrictions.
- No browser extraction of consumer ChatGPT/Gemini/Vibe web output; only supported API calls are used.
- Worker process is not sandboxed by default. Containerize with read-only root, unprivileged user, seccomp, network egress allowlists and no docker socket.
- Authentication only through local usernames/passwords; use SSO/OIDC and MFA for sensitive environments.
- Local full dependency install, typecheck, test and E2E validation were unavailable when the feature branch was authored. Do not deploy without those checks.

## Required gates before production

    pnpm --filter @tldraw/simple-server-example build-types
    pnpm --filter @tldraw/simple-server-example test
    pnpm lint-current

Security cases: uninvited user denied HTTP and WebSocket; viewer cannot mutate via forged WebSocket frames; revoked member denied new connection; expired invite fails; other user's jobs not exposed; CSRF blocked; malicious prompt output remains inert; worker credentials absent in browser bundle; failed provider never fabricates results; browser XSS/link protocol checks; session expiration; room and metadata DB recovery. Complete active-session revocation and file upload authorization before making it public.

## Upgrade, rollback, cleanup

This implementation is isolated to templates/simple-server-example and a new skill. Back out the feature branch or redeploy the previous commit if tests fail. Preserve .rooms and .brainstorm-data (including WAL files) across rollback. To reset a **development** deployment only, stop all services and delete those directories after confirming backups and ownership.

The repository's tldraw license forbids production deployment without the appropriate license/key. A free-to-users service still needs correct tldraw licensing.
