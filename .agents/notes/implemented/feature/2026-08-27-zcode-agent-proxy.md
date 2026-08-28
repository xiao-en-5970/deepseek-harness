# Agent Note: ZCode owns proxied agent turns

Status: implemented

English | [中文](2026-08-27-zcode-agent-proxy.zh.md)

## Problem

Selecting a GLM model in Harness still runs Harness's agent loop. It does not provide ZCode's native planning, tools, sessions, or workspace behavior.

## Decision

`@deepseek-ai/dsh-llm-zcode` runs ZCode's headless `app-server` for the `zcode` route. Each Harness session maps to a stable ZCode session. ZCode receives the tenant workspace as its working directory, executes its own tools there, and returns its published reasoning, answer, and usage stream to Harness.

The shipped `ZCode 代理` preset contains no Harness tools. The adapter rejects tool-bearing presets so one model request cannot execute the same operation through both runtimes. Credentials are resolved by Harness and passed only to the child process through an environment variable.

Workspace files are shared intentionally; histories and agent state are not. Tenant isolation still comes from the existing per-identifier workspace and `DSH_HOME` boundaries.

The sidebar exposes a Harness/ZCode mode switch. Both modes use the same workspace registry and files, but each mode lists and opens only its own sessions. Switching back restores the latest session for that mode in the current workspace. The `zcode` preset owns the `zcode/glm-5` route, so selecting the preset or creating a ZCode session cannot silently keep the previous Harness model.

## Alternatives considered

- **Use GLM through the existing Harness loop** — rejected because it changes only the model, not the agent product.
- **Embed the ZCode UI** — rejected because it would duplicate authentication, workspace navigation, and mobile behavior instead of reusing the existing Harness shell.
- **Expose both Harness and ZCode tools in one preset** — rejected because duplicate execution is unsafe.

## Consequences

ZCode must be installed in the deployment and the configured credential must exist. Text turns work; image-only input and auxiliary model calls are rejected. Harness-only plugins are not callable from ZCode until they are deliberately exposed through a separate bridge.

## Testing

The wire test pins request framing, reverse runtime-preference handling, responses, and streaming events. Preset and client-runtime tests pin route ownership, mode-specific blank-session reuse, and URL mode state. A live sandbox run additionally proves that the official ZCode process completes a Harness turn and creates a file in the identifier's shared workspace.
