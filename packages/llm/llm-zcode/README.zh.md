# `@deepseek-ai/dsh-llm-zcode`

[English](README.md) | 中文

通过 ZCode 的无头 `app-server` 代理一轮 Harness 对话。ZCode 负责自己的工具和工作区变更；适配器只把 ZCode 公开的推理／文本流与逐轮 token 用量返回 Harness，因此工具不会重复执行。

使用随附的“ZCode 代理”预设。选中的 Harness 会话会稳定映射到一个原生 ZCode 会话，而 ZCode 公开的推理、回答与 token 用量仍显示在 Harness 对话中。工作区文件共享；Harness 与 ZCode 的历史保持独立。

配置 `zcode` 提供方时，需要已安装的 `zcode` 命令、OpenAI 兼容端点和凭据引用。其他预设会暴露 Harness 工具，因此会被拒绝。省略 `dataDir` 时，适配器会在该标识符隔离的 `DSH_HOME` 下提供状态路径；只有选中的工作区目录与 Harness 共享。

模型选择器提供 `glm-5`、`glm-5.3-flash` 和 `glm-5.3`。随附的 ZCode 预设初始使用 `glm-5`；`defaultModel` 仍作为提供方的回退模型。

```yaml
- id: llm-zcode
  name: '@deepseek-ai/dsh-llm-zcode'
  config:
    command: /data/zcode/bin/zcode
    baseURL: https://open.bigmodel.cn/api/paas/v4
    apiKeyEnv: ZAI_API_KEY
    dataDir: /data/zcode/state
```

## 模型体验

### ZCode 代理轮次

#### 模型看到的内容

ZCode 通过 `session/create` 收到 Harness 指令与之前的文本历史，随后收到当前用户文本。ZCode 提供自己的原生工具目录，并在选定的租户工作区中执行。

#### Token 影响

导入的指令与历史会消耗提供方输入 token。ZCode 会报告已完成轮次的输入、输出、推理与缓存用量。

#### KV Cache 影响

稳定映射的 ZCode 会话可以复用未变化的提供方前缀。Harness 历史、指令、提供方端点或模型发生变化时，可能从第一个变化的 token 起失去复用。

## 已知限制与暂缓事项

- 不转发纯图片输入。
- Harness 工具与 Harness 专属插件在 ZCode 内不可用；有意设计的 MCP 桥接暂缓。
- ZCode 的安装与生命周期仍由部署负责。
