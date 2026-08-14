# Agent Note: 本机 Codex 文生图代理

Status: implemented

[English](2026-08-14-local-codex-image-proxy.md) | 中文

## 问题

DeepSeek Harness 可以理解图片请求，但发布的 DeepSeek 路由不会生成图片字节。期望的生成器是用户已完成鉴权的本机 Codex，而 Harness 运行在远端 Bohrium 沙盒。把 Codex 凭据或 OpenAI API Key 复制进沙盒会扩大凭据边界。若假定本机始终同步可达，本机离线时也只会表现为普通工具崩溃。

Tenant Web 还带来一个所有权约束。每个标识符都运行独立子进程，拥有独立的 home、设置、工作区和会话历史。模型工具属于每会话 preset，但浏览器路由和共享 worker 队列不能由每个 Agent 分别注册，否则会发生冲突。

## 决策

该能力沿现有 Host/Agent 边界拆分。

`@deepseek-ai/dsh-codex-image-proxy` 是由 Web bundle 只挂载一次的 Host 服务。它拥有持久文件队列、全局 worker 心跳、按租户分区的请求/结果/图片目录、结果校验和浏览器图片路由。Tenant Web 向每个子进程注入非敏感的 `DSH_TENANT_KEY`：值是 `default` 或现有 SHA-256 目录 key，绝不是用户提交的原始标识符。部署通过 `DSH_CODEX_IMAGE_QUEUE_ROOT` 让所有子进程指向同一共享队列根目录，并通过 `DSH_CODEX_IMAGE_PUBLIC_BASE_URL` 提供浏览器 origin。

`@deepseek-ai/dsh-tool-codex-image-proxy` 是 Agent 侧消费端，由 standard、code 和 cordis preset 挂载。它的 `generate_image` 工具接收完整 prompt 和可选的有界 context 摘要。固定指引要求模型针对图片生成意图选择该工具，排除秘密和无关历史，复用返回的精确 Markdown，并如实报告本机 worker 离线。意图路由仍然是普通模型工具选择；没有关键词中间件抢占 Agent loop。

本机 `scripts/codex-image-worker.mjs` 每十秒通过已鉴权的 `bohr sandbox` CLI 轮询，不暴露公共 claim 接口。claim 是从 pending 到 claimed 的原子重命名，并带可续租租约；过期 claim 会重新入队。忙碌期间，worker 同时续租和续心跳，执行 `codex exec --json --ephemeral --sandbox workspace-write`，让 `$imagegen` 只生成一张图片，校验图片签名和大小，上传到沙盒私有临时路径，再要求沙盒校验长度和 SHA-256，最后原子发布最终结果。取消标记会阻止迟到 worker 结果复活已终止调用。

没有新鲜心跳时，离线是规范的成功返回值，而不是抛出的基础设施异常。请求被接受后仍会继续观察心跳；worker 死亡会在完整生成超时前转成离线结果。真实 Codex 失败是携带有界诊断的规范 failed 值。工具仍会转发 `exec.signal`，其声明的工具调用超时比服务请求预算多五秒，让服务优先发布超时/取消状态。

浏览器路由只接受规范 UUID，并在当前子进程的租户目录内解析。只有完成结果记录已存在且文件长度匹配时才会提供图片。因此 URL 通过浏览器现有 HttpOnly 选择 Cookie 穿过 Tenant Web 网关，URL 中没有租户标识符或 worker 凭据。

## 验证

服务测试固定了心跳新鲜度、无请求发布的立即离线行为、持久请求结构、图片长度/校验和校验以及真实 HTTP 图片响应。工具测试固定了 schema 注册、系统指引、离线模型渲染和参数拒绝。worker 测试固定了 CLI 校验和支持图片识别。发布 Web 组合目录包含 `generate_image`，同时全局工具层仍为空。Tenant 启动器测试继续覆盖生命周期，并新增稳定子进程 key 注入。

实现前使用 `codex exec --json --ephemeral` 和 `$imagegen` 做了本机 Codex 探针，成功生成有效的 1254×1254 PNG。探针还证明 worker 必须请求 `workspace-write`：默认只读 sandbox 可以在 Codex 托管图片目录生成图片，却无法把结果复制进每请求工作目录。

## 备选方案

**把 OpenAI API Key 放进沙盒并直接调用 Image API。** 对本次要求的运行方式不予采纳，因为它会在远端环境复制本机 Codex 鉴权，并改变计费和凭据所有者。Host seam 仍允许未来增加直接 provider，而无需修改模型工具。

**在公共 Harness origin 暴露 claim 和上传接口。** 不予采纳，因为它会新增 bearer 鉴权的远程控制面，需要向两端分发秘密，并扩大请求正文和图片上传攻击面。本机已经拥有鉴权后的 Bohrium CLI 通道。

**在每个 preset 中挂载一个合并了工具和路由的插件。** 不予采纳，因为并发会话会争夺单一 HTTP 路由，而且持久 worker 队列是 Host 能力，不是每 Agent 展示能力。

**在 Agent loop 前拦截图片关键词。** 不予采纳，因为语言意图不是稳定关键词语法，这会绕过普通模型可见工具历史与策略，也无法可靠收集相关对话上下文。

**只返回沙盒文件路径。** 不予采纳，因为浏览器会有意拒绝渲染任意本地 Markdown 图片路径。所选租户的 HTTP 路由提供可显示的同源 URL，而不开放通用文件服务。

## 后果

只有本机 worker 持续心跳时文生图才可用，每个请求在领取前最多等待一个轮询间隔。本机保留 Codex 凭据和生成费用；远端沙盒只保留 prompt、有界 context、状态记录和生成图片。多个标识符共享一个 worker 进程，但拥有不同队列和路由命名空间。

已完成图片会持久保留，使旧 transcript 继续显示。自动保留期和清理由于产品尚未定义保留时长而暂缓；运维需要为队列根目录配置容量或主动清理。首版协议一次生成一张新光栅图片，尚不传输参考图片、不流式返回进度，也不并发执行请求。
