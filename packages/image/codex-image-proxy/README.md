# @deepseek-ai/dsh-codex-image-proxy

English | [中文](README.zh.md)

Host-owned text-to-image bridge for the Web surface. `ctx.codexImageProxy.generate()` atomically publishes a tenant-keyed request, requires a fresh local-worker heartbeat, waits cooperatively with the caller's `AbortSignal`, validates the result file's length and SHA-256, and returns a same-origin browser URL. The service also owns the single `/api/codex-image-proxy/image/<request-id>` route.

The sandbox never receives the local Codex login or an OpenAI API key. The local worker reaches the queue through the already authenticated `bohr sandbox` CLI, runs `codex exec --ephemeral --sandbox workspace-write`, and uploads only the generated image plus bounded status metadata.

## Config

| Key | Default | Meaning |
|---|---|---|
| `queueRoot` | `$DSH_HOME/codex-image-proxy/v1` | Absolute sandbox queue root. Tenant Web deployments should set one shared root. |
| `tenantKey` | `default` | `default` or the SHA-256 key injected by `dsh tenant-web`; the original user identifier is never written to the queue. |
| `publicBaseUrl` | empty | Browser-visible HTTP(S) base URL. Generation fails descriptively while empty because no displayable URL can be returned. |
| `workerFreshnessMs` | `35000` | Maximum heartbeat age before the worker is reported offline. |
| `resultPollIntervalMs` | `500` | Durable result polling interval inside the sandbox process. |
| `requestTimeoutMs` | `600000` | End-to-end request budget; the tool adds a five-second policy margin. |
| `maxImageBytes` | `20971520` | Maximum returned image size. |

The shipped Web row reads:

```text
DSH_CODEX_IMAGE_QUEUE_ROOT
DSH_CODEX_IMAGE_PUBLIC_BASE_URL
DSH_TENANT_KEY (injected by tenant-web; do not set manually)
```

Start the local worker from this repository:

```bash
pnpm run codex:image-worker -- \
  --sandbox <sandbox-id> \
  --queue-root /root/.dsh/codex-image-proxy-shared/v1
```

It polls every ten seconds by default. `--once` performs one heartbeat/claim pass for diagnostics. `CODEX_BIN` and `BOHR_BIN` may override executable paths without entering queue records.

## Queue contract

Requests move atomically from `tenants/<tenant>/pending` to `claimed`. A claim has a renewable lease; a dead worker's stale claim is requeued. Cancellation is a durable marker checked before publish. The image is uploaded to a private temporary path, verified inside the sandbox, renamed to its final path, and only then made visible by an atomic result record. Thus readers never observe a result that points at a partial upload.

Completed images are intentionally retained so transcript replay keeps working. This first version does not yet apply an automatic retention policy; operators must size or periodically clean the queue root after defining their product retention requirement.

## Security boundary

- Queue directories and JSON records are created with owner-only modes.
- Request ids are random UUIDs; route lookup accepts only canonical UUIDs and resolves only within the selected tenant child.
- The model supplies a prompt and bounded context through the consumer tool. Prompt guidance prohibits credentials, hidden instructions, and unrelated history.
- Tenant identifiers are hashed by the launcher. The queue sees only `default` or the hash.
- The public route relies on the deployment's existing outer authentication and tenant cookie. It is not a new anonymous worker API.

## Model Experience

Indirectly, through dsh-tool-codex-image-proxy, which renders the queue outcome and validated image reference.

#### KV Cache effect

The host service contributes no request prefix itself; the consuming tool owns schema and result history effects.

## Known Limitations and Deferred Work

- Generates one new raster image per request; reference-image transfer and progress frames are not implemented.
- The local worker processes requests serially and does not clean retained images automatically.
- A stopped local script is detected only after the heartbeat freshness window.
