# image/ — external image generation

English | [中文](README.zh.md)

This family bridges model-visible image requests to a separately authenticated local worker without moving the worker's Codex credentials into the Harness host.

| Package | Role | ctx key |
|---|---|---|
| [`codex-image-proxy/`](codex-image-proxy/README.md) | Host-owned durable queue, worker heartbeat, result validation, and browser image route | `ctx.codexImageProxy` |
| [`tool-codex-image-proxy/`](tool-codex-image-proxy/README.md) | Per-agent `generate_image` schema, prompt guidance, limits, and model-facing rendering | registers on `ctx.tools` |

The host service is mounted once by the Web composition. Agent presets mount only the model-facing consumer, so multiple sessions cannot collide while registering the HTTP route.
