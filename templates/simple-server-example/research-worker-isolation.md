# Research worker isolation: engineering skill

## Goal and assumptions

Build an API-driven research system in which a compromised provider worker cannot read another provider's credentials, access board/session storage, execute another provider through the controller, or open arbitrary outbound connections. Assume hostile prompts/results and possible worker compromise; trust the kernel, Docker daemon, controller, ingress, and egress proxies. A container is not a microVM or a per-tenant account boundary.

## Choose an isolation boundary

| Option                                                     | Maturity                           | Risk and operational burden                                              | Upgrade path                                                         |
| ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Compose internal networks + provider proxies (implemented) | Stable OSS mechanisms              | Shared kernel and trusted proxies; maintain images/secrets/host firewall | Rebuild patched images, run acceptance tests, roll forward by digest |
| Kubernetes + default-deny policy and external secrets      | Stable with a policy-enforcing CNI | Greater operational burden; policies must actually be enforced           | Keep worker protocol, migrate deployment controls                    |
| MicroVM per job/provider account                           | Deployment-specific                | Stronger boundary, cold starts, provisioning and account costs           | Start with sensitive tenants; validate state destruction             |

## Encode falsifiable invariants

- Worker configuration names exactly one provider; only that provider key and its unique controller token are mounted. No ambient API-key environment variables, Docker socket, shared database, or source-tree mount.
- Root filesystem is immutable; UID/GID are non-root; all capabilities are dropped; privilege escalation is disabled. Keep Docker's default seccomp. Writable tmpfs is bounded and noexec/nosuid/nodev. Apply CPU, memory, swap, PID, FD and log limits.
- Worker has only an internal network. Disable embedded-DNS external forwarding (internal service names still resolve); otherwise DNS can bypass the HTTPS egress policy. A trusted egress proxy admits only CONNECT to its exact API hostname on TCP443, rejects IP literals/reverse-DNS shortcuts and private destinations, and denies everything else. TLS verification remains end-to-end; no redirects or direct fallback.
- The API accepts production traffic only from a dedicated ingress socket address. Host/forwarded-header claims are not a substitute. Otherwise a compromised worker can register a user and use the controller to invoke other providers.
- The controller checks current board role before queueing/dispatch and before publishing. Worker requests contain prompt/system/provider only, never cookies, user IDs or board storage handles.
- Only one upstream job runs in a provider process. Cap queued work globally; permit distinct providers in parallel. Bound decoded response bytes and whole-job time. Abort upstream work on response/socket disconnect after the request body has completed.
- Log generic statuses and infrastructure metrics; suppress credentials, request bodies and raw upstream exceptions. Treat citations/model output as untrusted data.

## Validate mechanisms, then composition

```sh
pnpm --filter @tldraw/simple-server-example test-ci
pnpm typecheck --filter @tldraw/simple-server-example
pnpm --filter @tldraw/simple-server-example build
node templates/simple-server-example/deploy/research/check-browser-secrets.mjs
python3 templates/simple-server-example/deploy/research/smoke.py
```

Require behavioral tests for cross-board HTTP denial, real WebSocket viewer-write denial, editor broadcasts, immediate member revocation, expired invites, dispatch revocation, reflected secrets, malformed/oversized/timeout responses, proxy outage, disconnect cancellation and recovery. Inspect real container mounts, IDs, capabilities and cgroups; test direct Internet, metadata, sibling-worker and worker-to-API denial plus approved TLS connectivity. A YAML/JSON assertion cannot prove kernel enforcement.

Use dummy credentials for infrastructure tests. Paid-provider/model/grounding validation is a separate credential-dependent acceptance gate. Scan pinned dependencies against current advisories; record scoped findings separately from unrelated monorepo findings. Do not claim successful Docker or live-provider validation when the infrastructure/credentials are unavailable.

## Operate and roll back

Provision host-protected secret files with ownership readable by the container UID; file-backed Compose secrets do not encrypt storage or reliably remap host file ownership. Rotate a provider key/token and recreate its worker/controller; refresh ingress DNS during controller replacement. Back up metadata and room SQLite databases consistently with WAL state. Record image digests and verification evidence. Roll back reviewed images/configuration while preserving data; if isolation breaks, disable research instead of restoring unsandboxed workers. Delete volumes only in disposable tests or after explicit backup verification.
