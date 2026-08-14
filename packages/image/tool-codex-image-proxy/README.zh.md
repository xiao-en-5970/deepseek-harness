# @deepseek-ai/dsh-tool-codex-image-proxy

[English](README.md) | 中文

这是 [`ctx.codexImageProxy`](../codex-image-proxy/README.md) 的每 Agent 模型消费端。它注册 `generate_image`，告诉模型何时调用，对 prompt 和上下文摘要设限，转发取消信号，并把宿主结果渲染为助手可以直接展示给用户的精确 Markdown。

## 工具

| 工具 | 参数 | 结果 |
|---|---|---|
| `generate_image` | `prompt`（必填）、`context`（可选） | 带展示 URL 和已校验元数据的 `generated`、`offline` 或 `failed` |

`prompt` 是完整视觉规格。`context` 是相关对话事实的简洁摘要，必须排除凭据、隐藏系统指令和无关历史。默认上限分别为 12,000 和 20,000 个字符。

## 组合

宿主服务只应在 Web bundle 中挂载一次。需要文生图能力的每个 Agent preset 挂载此工具：

```yaml
- id: tool-codex-image-proxy
  name: '@deepseek-ai/dsh-tool-codex-image-proxy'
```

如果缺少 `ctx.codexImageProxy`，该行会保持等待，而不会注册一个无法执行的工具。

## 模型体验

### `generate_image` 工具 schema

#### 模型看到的内容

注册的 [`generate_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-codex-image-proxy) 接受完整 prompt 和相关的非敏感上下文。其结果为 `generated`、`offline` 或 `failed`；生成成功时提供精确 Markdown 和沙盒路径，图片字节不会进入模型上下文。

#### Token 影响

只要 preset 处于活动状态，固定的选择指引和工具 schema 就会增加稳定的请求前缀。每次调用会将有界 prompt、context、状态、URL、路径、大小、MIME 类型和 SHA-256 保留在会话历史中，直到压缩发生。

#### KV Cache 影响

组合与配置不变时，稳定前缀可以复用。每次新工具调用和结果只追加到对话，不会重写更早的前缀。

## 已知限制与后续工作

- 意图检测依赖系统提示词引导下的模型工具选择，不是关键词拦截器。
- 首版只支持文生图，并依赖助手遵循“复用返回的精确 Markdown”指令才能行内显示图片。
