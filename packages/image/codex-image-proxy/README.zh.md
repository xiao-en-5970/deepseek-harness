# @deepseek-ai/dsh-codex-image-proxy

[English](README.md) | 中文

这是 Web 界面中由宿主拥有的文生图桥接服务。`ctx.codexImageProxy.generate()` 会原子发布按租户分区的请求，要求本机 worker 心跳仍然新鲜，携带调用方的 `AbortSignal` 协作等待，校验结果文件长度与 SHA-256，最终返回同源浏览器 URL。该服务还独占 `/api/codex-image-proxy/image/<request-id>` 路由。

沙盒不会收到本机 Codex 登录态或 OpenAI API Key。本机 worker 通过已有鉴权的 `bohr sandbox` CLI 访问队列，使用 `codex exec --ephemeral --sandbox workspace-write` 运行任务，只上传生成图片和有界状态元数据。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `queueRoot` | `$DSH_HOME/codex-image-proxy/v1` | 沙盒内绝对队列根目录。Tenant Web 部署应设置一个共享根目录。 |
| `tenantKey` | `default` | `default` 或 `dsh tenant-web` 注入的 SHA-256 key；原始用户标识符不会写入队列。 |
| `publicBaseUrl` | 空 | 浏览器可见的 HTTP(S) 基础地址。为空时会描述性失败，因为无法返回可显示 URL。 |
| `workerFreshnessMs` | `35000` | 心跳超过该时间后把 worker 报告为离线。 |
| `resultPollIntervalMs` | `500` | 沙盒进程内持久结果轮询间隔。 |
| `requestTimeoutMs` | `600000` | 端到端请求预算；工具层额外增加五秒策略余量。 |
| `maxImageBytes` | `20971520` | 最大返回图片大小。 |

发布的 Web 配置读取：

```text
DSH_CODEX_IMAGE_QUEUE_ROOT
DSH_CODEX_IMAGE_PUBLIC_BASE_URL
DSH_TENANT_KEY (injected by tenant-web; do not set manually)
```

其中 `DSH_TENANT_KEY` 由 tenant-web 注入，不要手工设置。

在本仓库启动本机 worker：

```bash
pnpm run codex:image-worker -- \
  --sandbox <sandbox-id> \
  --queue-root /root/.dsh/codex-image-proxy-shared/v1
```

默认每十秒轮询一次。`--once` 只进行一次心跳/领取，适合诊断。可以用 `CODEX_BIN` 和 `BOHR_BIN` 覆盖可执行文件路径，这些值不会进入队列记录。

worker 默认最多并行运行两个 Codex 生成任务。如果本机 CPU、内存和 Codex 限流允许，可以用 `--concurrency <n>` 设置其他正整数上限。队列领取仍然是原子的，每个活跃请求也会独立续租。

## 队列协议

请求从 `tenants/<tenant>/pending` 原子移动到 `claimed`。claim 带可续租租约；worker 异常退出后，过期 claim 会重新入队。取消是持久标记，发布前必须检查。图片先上传到私有临时路径，在沙盒内校验后重命名到最终路径，随后才通过原子结果记录变为可见。因此读取方不会看到指向半成品上传的结果。

完成图片会保留，以保证 transcript 回放继续有效。首版尚未自动执行保留期清理；运维需要在确定产品保留策略后，为队列根目录配置容量或周期清理。

## 安全边界

- 队列目录和 JSON 记录使用仅属主可访问的权限创建。
- 请求 id 是随机 UUID；路由只接受规范 UUID，且只能在当前选中租户子进程内解析。
- 模型通过消费工具提供 prompt 和有界 context。提示词明确禁止凭据、隐藏指令和无关历史。
- 租户标识符由启动器哈希；队列中只出现 `default` 或哈希值。
- 公共路由依赖部署现有的外围鉴权和租户 Cookie，并不是新的匿名 worker API。

## 模型体验

通过 dsh-tool-codex-image-proxy 间接影响模型，由后者渲染队列结果和已校验图片引用。

#### KV Cache 影响

宿主服务本身不贡献请求前缀；消费工具负责 schema 和结果历史带来的影响。

## 已知限制与后续工作

- 每次只生成一张新光栅图片；尚未实现参考图片传输和进度帧。
- 本机 worker 不会自动清理保留图片；运维需要自行确定保留策略。
- 本机脚本停止后，需要等到心跳新鲜度窗口超时才会被判定为离线。
