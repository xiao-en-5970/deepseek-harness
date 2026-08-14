# image/：外部图片生成

[English](README.md) | 中文

本能力家族将模型可见的图片生成请求桥接给一台独立鉴权的本机 worker，同时不会把 worker 的 Codex 凭据放进 Harness 宿主。

| 包 | 职责 | ctx key |
|---|---|---|
| [`codex-image-proxy/`](codex-image-proxy/README.md) | 宿主拥有的持久队列、worker 心跳、结果校验和浏览器图片路由 | `ctx.codexImageProxy` |
| [`tool-codex-image-proxy/`](tool-codex-image-proxy/README.md) | 每个 Agent 独立挂载的 `generate_image` schema、提示词指引、限制和模型结果渲染 | 注册到 `ctx.tools` |

Web 组合只挂载一次宿主服务；Agent preset 只挂载面向模型的消费端，因此多个会话不会在注册 HTTP 路由时发生冲突。
