# Research canvas: deployment and verification

## Status and scope

This example provides accounts, private boards, editor/viewer invitations, a shared editable tldraw canvas, mind-map pinning, and parallel API-based research using OpenAI, Gemini, Mistral, and Tavily. It remains a development preview: the container architecture is implemented, but production approval requires the deployment checks below. Consumer ChatGPT/Gemini/Vibe web UIs are not scraped.

The Compose deployment uses **one worker and one egress proxy per provider**. Every worker has a separate internal Docker network, one provider key, and a unique API-to-worker token. The API holds only worker tokens; workers have no board database or browser-session credentials. The frontend contains neither kind of credential. Missing provider endpoints disable research for that provider; invalid configuration fails startup. The former single-worker URL/shared-secret fallback is removed.

| Boundary          | Implemented control                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution         | UID/GID 10001, read-only root, all capabilities dropped, no-new-privileges, Docker default seccomp, no Docker socket, bounded noexec/nosuid/nodev tmpfs                            |
| Worker networking | API ingress restricted to a dedicated proxy; one internal network per provider, no published worker/proxy ports, no direct Internet route; external DNS forwarding disabled        |
| Egress            | One Squid proxy per provider; CONNECT only, port 443 only, exact provider API hostname only, private/reserved destination IP denial, default deny                                  |
| Transport         | Explicit Undici ProxyAgent, TLS certificate verification, redirects rejected; no direct-network fallback                                                                           |
| Secrets           | Read-only `/run/secrets` files, provider-specific API key and worker token; inline/foreign-provider secrets rejected                                                               |
| Resource control  | Worker 256 MiB/0.5 CPU/64 PIDs; proxy 128 MiB/0.5 CPU/64 PIDs; API 512 MiB/1 CPU/64 PIDs; bounded logs/file descriptors                                                            |
| Failure handling  | One job per provider worker; parallel providers, 64 pending jobs maximum, 105-second whole-job upstream deadline, bounded response bytes, generic errors, no error-body forwarding |
| Board isolation   | Editor authorization at submission and dispatch; authorization rechecked before publishing results; revoked members lose HTTP and live socket access                               |

API destinations are `api.openai.com`, `generativelanguage.googleapis.com`, `api.mistral.ai`, and `api.tavily.com`. Source links are returned as data; the worker does not fetch cited pages. The proxy is a trusted enforcement component with Internet connectivity; this is process/network separation, not a VM boundary. A kernel/container-runtime or proxy compromise is outside that boundary. All boards using one provider share its worker and provider account; no browser/cookie/conversation context is reused. OpenAI requests and Mistral conversations set `store: false`; Tavily answer synthesis is disabled.

Docker Compose secrets backed by local files are bind mounts, **not an encrypted secret store**. Protect the host and secret directory. For stronger tenant boundaries use separate deployments/provider accounts, or migrate this same worker protocol to Kubernetes with enforced default-deny NetworkPolicies and a managed secret store. Compose is the implemented OSS baseline; Kubernetes and managed isolation are not shipped by this change.

## Build and automated checks

Requires Node >=22.12 for development, the pinned pnpm from `packageManager`, Python 3 for Docker smoke tests, and Docker Engine with Compose v2 for deployment. Images use Node 24 LTS. Run from repository root:

```sh
corepack enable
pnpm install --frozen-lockfile --filter @tldraw/simple-server-example... --ignore-scripts
pnpm rebuild better-sqlite3 esbuild
pnpm --filter @tldraw/simple-server-example test-ci
pnpm typecheck --filter @tldraw/simple-server-example
pnpm --filter @tldraw/simple-server-example build
pnpm --filter @tldraw/simple-server-example build-server
pnpm --filter @tldraw/simple-server-example build-worker
pnpm lint-current
node templates/simple-server-example/deploy/research/audit-research.mjs
python3 templates/simple-server-example/deploy/research/smoke.py
```

Tests fail when no tests are discovered. The scoped audit fails on template dependency advisories or an unavailable/malformed audit response; it also reports repository-wide counts without treating unrelated packages as a template pass/fail decision. The root Vitest project includes this template. Tests cover provider selection/authentication, file-secret validation, cross-provider credentials, bounded responses, proxy denial, safe failures/timeouts, HTTP board access, expired/revoked invitations, real WebSocket viewer mutation rejection, editor-to-viewer collaboration, active-member revocation, and dispatch-time authorization checks. The Docker smoke test creates disposable fake credentials, builds/starts the deployment, inspects runtime controls, checks approved TLS destinations, rejects direct/lateral/metadata egress, checks secret mounts/read-only filesystems, stops a proxy and checks safe failure, then removes its own volumes. It never submits paid provider requests.

`.github/workflows/research-isolation.yml` runs these build/type/security/runtime checks without production secrets. A passing source-level configuration test alone is not evidence that Docker network controls work on your host. Run the Docker test on the actual target engine too. Browser node editing/pinning and live paid-provider outputs still require the acceptance session below.

## Secret provisioning and startup

Use a dedicated Linux Docker host. Before building, review/pin the resulting base/proxy image digests and scan images under your organization's policy; distro packages receive security updates at build time. Rebuild regularly, test, then roll forward by immutable image digest. Never use `seccomp=unconfined`, privileged mode, host networking, or publish a worker/proxy port.

The API and workers run as numeric UID/GID 10001. File-backed Compose secrets preserve host file ownership; Compose `uid`/`gid`/`mode` remapping cannot be relied on for these files. Provision files through your secret manager or, on a local Linux host:

```sh
export RESEARCH_SECRETS_DIR="$HOME/.config/tldraw-research-secrets"
install -d -m 0700 "$RESEARCH_SECRETS_DIR"
for provider in openai gemini mistral web; do
  openssl rand -hex 32 > "$RESEARCH_SECRETS_DIR/$provider-worker-token"
done
# Place the corresponding real API key in each file with a secure editor/secret manager:
# openai-api-key, gemini-api-key, mistral-api-key, web-api-key
# Do not place credentials in command arguments, .env, the checkout, or the build context.
sudo chown 10001:10001 "$RESEARCH_SECRETS_DIR/"*-worker-token "$RESEARCH_SECRETS_DIR/"*-api-key
sudo chmod 0400 "$RESEARCH_SECRETS_DIR/"*-worker-token "$RESEARCH_SECRETS_DIR/"*-api-key

docker compose -f templates/simple-server-example/compose.research.json config --quiet
docker compose -f templates/simple-server-example/compose.research.json up -d --build --wait
pnpm --filter @tldraw/simple-server-example dev-client
```

Provision all four provider files for the supplied four-provider stack. For a subset, remove the unused provider's worker/proxy services, networks, secret declarations, and API URL/token entry together; never map one provider to another provider's worker. Do not reuse worker tokens. Missing/short/unreadable secret files prevent worker startup.

A dedicated ingress proxy publishes **127.0.0.1:5858 only**. The API itself publishes no ports and accepts production requests only from the ingress proxy at 172.31.240.2, checked against the socket address rather than forwarded headers. The ingress uses its own internal 172.31.240.0/24 subnet; change that subnet, the proxy address, API address (172.31.240.3), and the API allowlisted address together if the subnet conflicts with your host routes. Provider containers cannot register accounts or dispatch work through the API. Vite serves the development UI at http://localhost:5757 and proxies API/WebSocket traffic while preserving Host for same-origin checks. Workers default to loopback when launched directly; Compose deliberately sets `HOST=0.0.0.0` inside the private network without publishing ports. `dev-brainstorm` starts only API/UI and does not launch an unsandboxed worker. With no endpoint mapping, the API still supports private/collaborative boards while research jobs fail as unconfigured.

For deployment, serve `templates/simple-server-example/src/client/dist` through your TLS frontend and reverse proxy `/api/brainstorm/` and `/connect/` to the loopback API. Preserve the original Host header and WebSocket upgrades. The API runs with `NODE_ENV=production` for Secure/HttpOnly/SameSite=Strict session cookies. The Compose stack does not provision DNS, TLS, SSO, or an Internet-facing frontend.

## Acceptance and operational checks

1. Register an account; create two private boards. An unrelated account must not read either board, its jobs, or its WebSocket room.
2. Invite editor and viewer accounts. Editors must pin/edit/move nodes and launch parallel research. Viewers must see live updates while HTTP research and forged canvas mutations remain denied.
3. Launch one live research job with each configured provider; confirm actual cited findings, pin them, move/edit the nodes, and confirm the changes on another editor's browser. This requires valid paid-provider credentials, quotas, and approved egress. Model availability and grounding tools must be validated for your accounts.
4. Revoke a member during collaboration/research. Its socket must close, reconnect must fail, and a revoked submitter's result must not publish. Jobs still visible to authorized board members remain board-scoped.
5. Rotate each worker token/key by updating its file and recreating the affected worker plus API. Confirm denied access using the former token and successful new-token requests. Never echo tokens into logs.
6. Check `docker compose ... ps`, worker `/health` inside the container, container resource usage, and generic job failures. No prompt, authorization header, provider key, or raw upstream exception is logged by the worker. Proxy access logging is disabled; container logs are capped. Add infrastructure metrics/auditing without recording credentials or research bodies.

The Docker test requires a Docker daemon, bridge network/firewall support, image/package registry access, DNS, and outbound TLS to the provider APIs. Live-provider validation also requires real credentials and quota. Passing mocked provider tests cannot validate account-specific model/tool permissions.

## Remaining limitations

- No SSO/MFA, account recovery, email verification, per-tenant API budgets, or tenant-specific provider policy. Use an identity-aware frontend and separate deployments for sensitive tenants.
- Automatic layout/collapse/cycle detection and browser extraction are not implemented.
- Model outputs and citations are untrusted data. Results may remain unstructured; links are protocol-filtered but their factual accuracy is not independently verified.
- Editors' browsers pin findings using stable shape IDs; this reduces duplicate pinning but is not a server-side transaction guarantee.
- Authentication metadata and canvas rooms use separate SQLite databases. Coordinate encrypted backups of both, including WAL state. Durable cross-process job queues/retries are not implemented; interrupted jobs are marked interrupted on restart.
- Arbitrary uploads/unfurling and legacy public rooms stay disabled by default. Do not enable legacy rooms for private deployments.
- Shared-provider worker reuse does not provide per-job microVM isolation or per-tenant provider-account separation.
- tldraw licensing requirements still apply to production use.

## Upgrade, rollback, cleanup

Back up the `board-data` volume with all writers stopped before rollout. Rebuild/test images, record their digests, and deploy the reviewed revision. Roll back the application images/configuration together while keeping the existing data volume; this change adds no database migration. Do not restore the former shared-worker/unsandboxed setup as a rollback shortcut: disable research by removing endpoint mappings instead. Rotate secrets if exposure is suspected.

`docker compose -f templates/simple-server-example/compose.research.json down` stops the deployment without deleting board data. `down --volumes` is destructive and is only appropriate for disposable test environments after backups are verified. The smoke test uses its own project/volume and cleans those up automatically.

References: [Docker service controls](https://docs.docker.com/reference/compose-file/services/), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [Squid access policy](https://www.squid-cache.org/Doc/config/http_access/), [Undici ProxyAgent](https://undici.nodejs.org/#/docs/api/ProxyAgent).

## Verification record (2026-10-16)

- 67 automated security/collaboration tests pass across seven files, including real HTTP disconnect cancellation and WebSocket access controls.
- Targeted `pnpm typecheck --filter @tldraw/simple-server-example` passes for the template and its workspace dependencies. The local runner denies tsx CLI Unix IPC, so the asset-refresh subprocess used the equivalent `node --import tsx` loader; no repository source workaround was needed.
- Browser, API, and fully bundled worker builds pass. Both bundled Node entrypoints start and enforce their expected HTTP authorization boundaries. Credential-marker scanning of the built frontend passes.
- Targeted oxlint and explicit changed-file formatting checks pass. The repository's existing lint-current formatter passes its file list as a single argument, so formatting was additionally checked with each path as a separate argument.
- The scoped production-dependency audit reports zero template advisories after updating Fastify to 5.12.5, Undici to 7.29.1, fast-uri to 3.1.8, patching affected build-tool transitive dependencies, and removing the unused React Router dependency. The repository-wide audit still reports unrelated findings (7 critical, 43 high, 54 moderate, 14 low); this work does not claim to remediate those packages or establish their exploitability.
- Native nginx 1.24 and Squid 6.14 parsers accept the proxy configurations. Squid distribution asset paths were adjusted only in temporary verification copies. These parser checks do not substitute for the shipped Debian image/runtime tests.
- Docker smoke execution is blocked locally because the Docker CLI/daemon is unavailable. The dedicated GitHub Actions workflow includes image build, proxy configuration parsing, actual runtime isolation checks, and proxy failure handling. Its result must be checked before production approval.
- Live paid-provider calls, account-specific model/grounding permissions, TLS frontend deployment, and browser canvas acceptance remain credential/infrastructure-dependent checks; none is claimed as completed here.

The first GitHub Docker run successfully built every image and parsed all proxy configurations, then caught an ingress address allocation collision before runtime assertions. Both API/ingress addresses are now reserved explicitly. Worker/API/ingress external DNS forwarding is also disabled while Docker service-name resolution remains available; the Docker smoke test checks external DNS denial.
