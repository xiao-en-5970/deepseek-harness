# @deepseek-ai/dsh-tool-codex-image-proxy

English | [中文](README.zh.md)

Per-agent model consumer for [`ctx.codexImageProxy`](../codex-image-proxy/README.md). It registers `generate_image`, teaches the model when to call it, bounds the prompt and contextual summary, forwards cancellation, and renders the host result as exact Markdown the assistant can show to the user.

## Tool

| Tool | Arguments | Result |
|---|---|---|
| `generate_image` | `prompt` (required), `context` (optional) | `generated` with a display URL and validated metadata, `offline`, or `failed` |

`prompt` is the complete visual specification. `context` is a concise summary of relevant conversation facts; it must exclude credentials, hidden system instructions, and unrelated history. Defaults cap them at 12,000 and 20,000 characters respectively.

## Composition

The host service belongs in the Web bundle once. This tool belongs in each agent preset that should support image generation:

```yaml
- id: tool-codex-image-proxy
  name: '@deepseek-ai/dsh-tool-codex-image-proxy'
```

Mounting this package without `ctx.codexImageProxy` leaves the row waiting instead of registering a tool that cannot execute.

## Model Experience

### `generate_image` tool schema

#### What the model sees

The registered [`generate_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-codex-image-proxy) accepts a complete prompt and relevant non-secret context. Its result is `generated`, `offline`, or `failed`; successful rendering supplies exact Markdown plus the sandbox path, while image bytes remain outside model context.

#### Token effect

The fixed selection guidance and tool schema add a stable request prefix while the preset is active. Each call retains its bounded prompt, context, status, URL, path, size, MIME type, and SHA-256 in session history until compaction.

#### KV Cache effect

The stable prefix is reusable while composition and configuration stay unchanged. Each new tool call and result append to the conversation without rewriting the earlier prefix.

## Known Limitations and Deferred Work

- Intent detection is model tool selection guided by the system-prompt section, not a keyword interceptor.
- The first version supports text-to-image only and depends on the assistant following the returned exact-Markdown instruction for inline display.
