# Agent Note: Browser directory upload into a remote Workspace

Status: implemented

English | [中文](2026-08-14-browser-directory-upload.zh.md)

## Problem

The browse directory picker lets a remote browser select paths that already exist on the Host, but browser-local files are outside that filesystem. A user reaching Harness through a remote sandbox URL therefore cannot turn a local project folder into a Host Workspace without a separate CLI transfer.

## Decision

The existing `browse` directory-picker interaction owns directory upload beside listing and New folder. Its capability and Host API add four unary operations: `beginDirectoryUpload`, ordered `writeDirectoryUpload` chunks, `completeDirectoryUpload`, and idempotent `abortDirectoryUpload`. The Client runtime forwards those operations; the existing browse flow renders **Upload local folder**, reads a `webkitdirectory` selection, preserves each file's root-relative path, and uses the chunk bound returned by `begin`. A successful `complete` goes through the flow's existing `onPicked` path, so workspace adoption and its error ownership do not fork.

The Host treats one directory selection as a bounded transaction. `begin` validates the declared file count and byte total, confines the realpath-canonical parent below `uploadRoot` (the Host account home by default), and creates a hidden staging root with an opaque upload id. Each chunk is canonical base64, ordered by exact acknowledged offset, bounded independently from per-file and aggregate limits, and written to a hidden temporary file. The decoded chunk default is 512 KiB: after base64 expansion and the JSON envelope, one request remains below the common 1 MiB reverse-proxy body limit. Relative paths reject empty, absolute, dot, separator-bearing, and symlink-crossing segments. A terminal chunk publishes one file; `complete` requires the exact declared file and byte totals, then atomically renames the staging root to the requested directory. Until that rename, the Workspace path does not exist. Abort, idle expiry, and graceful plugin teardown remove incomplete staging roots; after an ungraceful process exit, any survivor retains the hidden staging name and is never adopted as the target.

All four upload RPCs join the browser transport's loopback-only privileged set. `trustedHosts` is a DNS-rebinding and same-origin fence, not authentication, and file-content writes cannot be granted by it. Remote deployments expose upload only through an authenticated reverse proxy that relays to the loopback listener; ordinary direct LAN trusted-host access receives HTTP 403.

## Alternatives considered

- **An Nginx or sidecar upload endpoint.** Rejected because it forks authentication, limits, error handling, workspace adoption, and lifecycle cleanup outside the Harness plugin graph. The feature belongs to the existing browse capability and API contract.
- **One whole-directory or whole-file JSON request.** Rejected because the carrier buffers JSON and base64 expands the payload; a large local project would turn one request into an avoidable resident-memory and body-limit spike. Host-advertised chunks keep each request bounded.
- **A multipart/raw streaming route beside the RPC carrier.** It avoids base64 overhead, but adds a second client transport and bypasses the typed request/result/error discipline. The chunked unary path is sufficient for the current remote-sandbox use case; a streaming carrier remains an optimization if measured throughput requires it.
- **Mounting or directly exposing the browser machine's filesystem.** Browsers do not grant a remote origin an ambient local filesystem mount. File System Access handles are browser-local capabilities and still require explicit reads and transfer; the directory input is the portable user-gesture boundary available to this flow.

## Consequences

- Remote users can upload a local non-empty project tree into the selected Host directory and open it as a Workspace without a separate CLI.
- The wire gains four methods and one typed failure code (`directory-upload-failed`); browse capability implementations must provide the transaction.
- Configuration controls upload root, chunk size, per-file bytes, aggregate bytes, file count, and idle lifetime. Smaller chunk bounds cost more RPCs; larger bounds cost more buffered JSON and base64 memory.
- Browser directory inputs do not report standalone empty directories, so empty-only branches are omitted. Uploads are sequential and do not resume after a tab/process interruption; retry begins a new isolated transaction.
- Base64 adds wire and encode/decode overhead. The implementation chooses bounded memory and one typed transport over maximum throughput.
