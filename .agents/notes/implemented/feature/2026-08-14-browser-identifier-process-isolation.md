# Agent Note: Browser identifier isolation through process-owned Harness homes

Status: implemented

English | [中文](2026-08-14-browser-identifier-process-isolation.zh.md)

## Problem

One long-running Web process owns one workspace registry, session persistence service, settings document, credentials store, attachment root, and browser upload root. A browser-only identifier or UI filter cannot isolate those owners: another client can still address the shared Host APIs directly, and a missed projection leaks another identifier's history. The entry prompt must therefore select a persistence owner before the Harness application connects.

## Decision

`dsh tenant-web` is a launcher-owned loopback gateway. It serves a blocking, script-free identifier form until the browser selects a tenant, then routes HTTP, SSE, and WebSocket traffic by a session-scoped HttpOnly cookie. Blank input selects a default child that retains the launcher's working directory, `HOME`, and `DSH_HOME`. A normalized non-blank identifier selects a lazily started `dsh web` child with its own working directory, `HOME`, `DSH_HOME`, and highest-precedence directory-picker confinement patch.

Identifiers are NFKC-normalized, trimmed, case-sensitive, and limited to 64 characters. Named tenant paths use only `sha256(identifier)` below the configured tenant root, so raw identifiers do not enter filesystem paths. A named child's private Harness home owns workspace registration, sessions, settings, credentials, attachments, and profile configuration; its private process home owns browser browsing, New folder, uploads, and default workspace execution. Restarting a child reopens the same roots.

The gateway starts children on first use, bounds them with `maxActiveTenants`, evicts the least-recent idle child at capacity, and stops inactive children after `idleTimeoutMs`. An HTTP response or open WebSocket retains a lease, so an in-use child cannot be evicted. Gateway shutdown terminates every owned child.

The generated named-tenant patch configures the default space's `.credentials.yaml` as a read-only `fallback-file` below the tenant-local credential document. Provider resolution is environment, tenant-local file, default fallback, then `.env`. The Models page continues to write and delete only the tenant-local document, so an override is identifier-specific and deleting it restores inheritance without copying a secret. Both files are watched; fallback changes hidden by a stronger layer emit no effective-update event.

The gateway exposes three owner routes for settings navigation: `/__dsh_tenant/current` returns only the current browser's selection, `/__dsh_tenant/reset` clears it and reopens the selector, and `/__dsh_tenant/default` selects the default directly. The General settings row capability-probes the first route and stays absent under ordinary `dsh web`; it never enumerates identifiers.

The selector is routing, not authentication. The gateway accepts loopback binding only, strips selector cookies and browser-origin headers on the private hop, and expects a remote deployment to supply TLS and authentication at an outer reverse proxy. Users who know another identifier can select it; hostile-code containment remains the sandbox policy's responsibility because sibling processes run under the same OS account.

## Directory-picker confinement

The browse backend accepts optional `browseRoot`. When present, omitted paths start there, breadcrumbs stop there, and realpath-canonical listing and directory creation outside it fail. Blank `uploadRoot` follows `browseRoot`, then the Host account home. The adaptive chooser forwards `browseRoot` and `uploadRoot` only when it mounts the browse backend, so the tenant patch constrains remote browsing without changing native chooser semantics.

## Verification

Pure tests pin normalization, canonical cookie encoding, hashed layouts, and the blocking selector. CLI tests pin parsing and numeric bounds. Browse-backend tests pin root breadcrumbs, outside and symlink escape rejection, directory creation, and upload fallback; a real Loader composition test pins adaptive forwarding. Credential-provider tests pin fallback precedence, local override/unset, permission checks, and effective hot-reload events. The browser acceptance creates workspaces and conversations under two identifiers plus the blank default, reconnects each cookie, observes disjoint workspace/session lists and roots, verifies default-key inheritance and local override restoration, then exercises both settings navigation paths.

## Alternatives considered

**Filter workspaces and sessions in the browser.** Rejected because Host APIs and WebSocket streams remain shared; every new endpoint becomes another potential cross-identifier leak.

**Add a tenant field to every service and persistence record in one process.** Rejected because workspace, session, settings, credentials, attachments, presets, tools, and future plugins would all need request-scoped tenant propagation. One missed singleton or background task breaks the isolation claim.

**Put the identifier in a URL prefix.** Rejected because the application currently emits origin-absolute API, plugin, and WebSocket paths. A cookie keeps every transport on the existing protocol without rewriting the assembled client.

## Consequences

Process and filesystem ownership make default-empty compatibility and named-tenant isolation auditable at the launch boundary instead of depending on complete endpoint filtering. The costs are one Node process per active identifier, first-use startup latency, and an origin-wide browser cookie: switching identifiers affects every tab for that origin. Provider credentials inherit from the default by deployment choice but remain independently overridable; all other settings stay isolated. The mechanism does not claim security isolation between hostile users on the same OS account.
