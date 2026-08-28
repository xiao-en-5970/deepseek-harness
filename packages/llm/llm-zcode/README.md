# `@deepseek-ai/dsh-llm-zcode`

English | [中文](README.zh.md)

Proxies one Harness conversation turn through ZCode's headless `app-server`. ZCode owns its tools and workspace mutations; the adapter returns only ZCode's published reasoning/text stream and per-turn token usage to Harness, so tools cannot execute twice.

Use the shipped `ZCode 代理` preset. The selected Harness session maps to a stable native ZCode session, while ZCode's published reasoning, answer, and token usage remain visible in the Harness transcript. Workspace files are shared; Harness and ZCode histories remain separate.

Configure the `zcode` provider with an installed `zcode` command, an OpenAI-compatible endpoint, and a credential reference. Other presets expose Harness tools and are rejected. When `dataDir` is omitted, the adapter supplies a state path below the identifier's isolated `DSH_HOME`; only the selected workspace directory is shared with Harness.

The model selector offers `glm-5.3-flash` and `glm-5.3`. The shipped ZCode preset starts with `glm-5.3-flash`; `defaultModel` remains the provider fallback. Other model ids fail with `UNKNOWN_MODEL` before ZCode starts.

```yaml
- id: llm-zcode
  name: '@deepseek-ai/dsh-llm-zcode'
  config:
    command: /data/zcode/bin/zcode
    baseURL: https://open.bigmodel.cn/api/paas/v4
    apiKeyEnv: ZAI_API_KEY
    dataDir: /data/zcode/state
```

## Model Experience

### ZCode-proxied turn

#### What the model sees

ZCode receives the Harness instructions and prior text history through `session/create`, then receives the current user text. ZCode supplies its own native tool catalog and works in the selected tenant workspace.

#### Token effect

The imported instructions and history consume provider input tokens. ZCode reports input, output, reasoning, and cache usage for the completed turn.

#### KV Cache effect

The stable mapped ZCode session can reuse an unchanged provider prefix. Changing the Harness history, instructions, provider endpoint, or model may invalidate reuse from the first changed token.

## Known Limitations and Deferred Work

- Image-only input is not forwarded.
- Harness tools and Harness-only plugins are unavailable inside ZCode; a deliberate MCP bridge is deferred.
- ZCode installation and lifecycle remain deployment responsibilities.
