# Agent Note: Local Codex image proxy

Status: implemented

English | [中文](2026-08-14-local-codex-image-proxy.zh.md)

## Problem

DeepSeek Harness can reason about an image request but its shipped DeepSeek route does not generate image bytes. The desired generator is the user's already authenticated local Codex installation, while Harness runs in a remote Bohrium sandbox. Copying Codex credentials or an OpenAI API key into that sandbox would widen the credential boundary. Treating the local machine as synchronously reachable would also make an offline laptop look like a generic tool crash.

Tenant Web adds another ownership constraint. Each identifier runs a separate child with its own home, settings, workspaces, and session history. A model tool belongs inside that per-session preset, but one browser route and one shared worker queue cannot be registered independently by every agent without collisions.

## Decision

The feature is split at the existing Host/Agent boundary.

`@deepseek-ai/dsh-codex-image-proxy` is a Host service mounted once by the Web bundle. It owns a durable filesystem queue, a global worker heartbeat, tenant-keyed request/result/image directories, result validation, and the browser image route. Tenant Web injects the non-secret `DSH_TENANT_KEY` into each child: `default` or its existing SHA-256 directory key, never the submitted identifier. Deployments point every child at one shared queue root through `DSH_CODEX_IMAGE_QUEUE_ROOT` and supply the browser origin through `DSH_CODEX_IMAGE_PUBLIC_BASE_URL`.

`@deepseek-ai/dsh-tool-codex-image-proxy` is the Agent-side consumer mounted by the standard, code, and cordis presets. Its `generate_image` tool accepts a complete prompt and an optional bounded context summary. Fixed guidance tells the model to select the tool for image-generation intent, exclude secrets and unrelated history, reuse the returned exact Markdown, and report a local-worker offline result honestly. Intent routing remains ordinary model tool selection; no keyword middleware can preempt the agent loop.

The local `scripts/codex-image-worker.mjs` polls through the authenticated `bohr sandbox` CLI every ten seconds. It never exposes a public claim endpoint. A bounded pool runs five independent generations by default and accepts an explicit positive `--concurrency` override. Claim is an atomic pending-to-claimed rename with a renewable lease; stale claims requeue. While busy, each request renews its own lease and the shared heartbeat, runs `codex exec --json --ephemeral --sandbox workspace-write`, asks `$imagegen` for exactly one image, validates its signature and size, uploads to a private temporary sandbox path, then asks the sandbox to verify length and SHA-256 before atomically publishing the final result. Cancellation markers prevent a late worker result from reviving an aborted call.

Offline is a canonical successful value when no heartbeat is fresh, not a thrown infrastructure error. Once accepted, a request continues to watch the heartbeat; a dead worker becomes an offline result before the full generation timeout. Actual Codex failures are canonical failed values with a bounded diagnostic. The tool itself still forwards `exec.signal`, and its declared tool-call timeout exceeds the service request budget by five seconds so the service can publish timeout/cancellation state first.

The browser route accepts only canonical UUIDs and resolves them inside the current child's tenant directory. It serves only after a completed result record exists and file length matches. The URL therefore crosses the Tenant Web gateway using the browser's existing HttpOnly selection cookie; no tenant identifier or worker credential appears in the URL.

## Verification

Service tests pin heartbeat freshness, immediate offline behavior without request publication, durable request shape, image length/checksum validation, and a real HTTP image response. Tool tests pin schema registration, system guidance, offline model rendering, and argument rejection. Worker tests pin CLI validation and supported-image detection. The shipped Web composition catalog includes `generate_image`, while the global tool layer remains empty. Tenant launcher tests continue to cover lifecycle and now also carry the stable child key.

A local Codex probe was run before implementation with `codex exec --json --ephemeral` and `$imagegen`; it produced a valid 1254 by 1254 PNG. The probe also established that the worker must request `workspace-write`: the default read-only sandbox could generate into Codex's managed image directory but could not copy the result into a per-request work directory.

## Alternatives considered

**Put an OpenAI API key in the sandbox and call the Image API directly.** Rejected for this requested operating model because it duplicates local Codex authentication in a remote environment and changes who owns billing and credentials. The Host seam leaves a future direct provider possible without changing the model tool.

**Expose claim and upload endpoints on the public Harness origin.** Rejected because it creates a new bearer-authenticated remote control surface, requires secret distribution into both environments, and widens request-body and image-upload attack surfaces. The local machine already has an authenticated Bohrium CLI channel.

**Mount one combined tool-and-route plugin in every preset.** Rejected because concurrent sessions would compete for the single HTTP route and because the durable worker queue is a Host capability, not per-Agent presentation.

**Intercept image keywords before the agent loop.** Rejected because language intent is not a stable keyword grammar, it would bypass normal model-visible tool history and policy, and it could not reliably collect the relevant conversation context.

**Return only a sandbox file path.** Rejected because the browser deliberately does not render arbitrary local Markdown image paths. The selected-tenant HTTP route supplies a displayable same-origin URL without broad file serving.

## Consequences

Image generation works only while a local worker is heartbeating, and a request may wait for the polling interval plus local pool capacity before claim. The local machine retains Codex credentials and generation cost; the remote sandbox retains only prompts, bounded context, status records, and generated images. Multiple identifiers share one bounded worker pool but have distinct queue and route namespaces.

Completed images remain durable so old transcripts continue to render. Automatic retention and cleanup are deliberately deferred until the product defines a retention period; operators must size or clean the queue root. The first protocol generates one new raster image at a time and does not yet transfer reference images, stream progress, or run requests concurrently.
