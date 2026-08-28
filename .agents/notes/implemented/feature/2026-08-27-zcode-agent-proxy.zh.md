# Agent Note：ZCode 负责代理轮次

Status: implemented

[English](2026-08-27-zcode-agent-proxy.md) | 中文

## 问题

在 Harness 中选择 GLM 模型仍然运行 Harness 自己的 Agent 循环，无法获得 ZCode 原生的规划、工具、会话与工作区行为。

## 决策

`@deepseek-ai/dsh-llm-zcode` 为 `zcode` 路由运行 ZCode 的无头 `app-server`。每个 Harness 会话稳定映射到一个 ZCode 会话。ZCode 使用该租户工作区作为工作目录，在其中执行自己的工具，并把公开的推理、回答和用量流返回 Harness。

随附的“ZCode 代理”预设不包含 Harness 工具。适配器拒绝带工具的预设，避免同一模型请求经两个运行时重复执行。凭据由 Harness 解析，仅通过环境变量传给子进程。

工作区文件有意共享；历史与 Agent 状态不共享。租户隔离仍由既有的逐标识符工作区和 `DSH_HOME` 边界提供。

侧边栏提供 Harness/ZCode 模式切换。两种模式使用同一套工作区注册表和文件，但每种模式只列出并打开自己的会话。切回时，会恢复当前工作区内该模式最近使用的会话。`zcode` 预设拥有 `zcode/glm-5` 路由，因此选择该预设或创建 ZCode 会话时，不会再静默沿用此前的 Harness 模型。

## 备选方案

- **通过既有 Harness 循环使用 GLM** —— 被否决，因为它只更换模型，并未更换 Agent 产品。
- **嵌入 ZCode UI** —— 被否决，因为这会重复实现认证、工作区导航和移动端行为，无法复用现有 Harness 外壳。
- **在同一个预设中同时暴露 Harness 与 ZCode 工具** —— 被否决，因为重复执行不安全。

## 影响

部署必须安装 ZCode，并具备所配置的凭据。文本轮次可用；纯图片输入和辅助模型调用会被拒绝。在通过独立桥接层明确暴露之前，ZCode 无法调用 Harness 专属插件。

## 测试

wire 测试固定请求帧、反向运行时偏好处理、响应和流事件。预设与客户端运行时测试固定路由所有权、按模式复用空白会话和 URL 模式状态。一次真实沙盒运行还证明官方 ZCode 进程能够完成 Harness 轮次，并在该标识符的共享工作区中创建文件。
