# Agent Note: Browser identifier isolation through process-owned Harness homes

Status: implemented

[English](2026-08-14-browser-identifier-process-isolation.md) | 中文

## Problem

一个长期运行的 Web 进程只拥有一套 workspace 注册表、会话持久化服务、设置文档、凭据存储、附件根目录和浏览器上传根目录。只存在于浏览器的标识符或 UI 过滤无法隔离这些所有者：其他客户端仍能直接访问共享 Host API，任何漏掉的投影都会泄露其他标识符的历史。因此，入口提示必须在 Harness 应用建立连接之前选定持久化所有者。

## Decision

`dsh tenant-web` 是启动器拥有的 loopback 网关。浏览器选择租户之前，它提供阻塞式、无脚本的标识符表单；选择后，由作用于会话的 HttpOnly Cookie 为 HTTP、SSE 与 WebSocket 流量选路。留空选择默认子进程，保留启动器的工作目录、`HOME` 与 `DSH_HOME`。经过规范化的非空标识符选择一个按需启动的 `dsh web` 子进程，该进程拥有独立的工作目录、`HOME`、`DSH_HOME`，以及最高优先级的目录选择限制 patch。

标识符经过 NFKC 规范化和首尾空白裁剪，区分大小写，且最多 64 个字符。命名租户路径在配置的租户根目录下只使用 `sha256(identifier)`，原始标识符不会进入文件系统路径。命名子进程的私有 Harness home 拥有 workspace 注册、会话、设置、凭据、附件与 profile 配置；其私有进程 home 拥有浏览器列举、「新建文件夹」、上传与默认 workspace 执行。子进程重启时重新打开同一套根目录。

网关在首次使用时启动子进程，通过 `maxActiveTenants` 约束数量，在达到上限时驱逐最久未使用的空闲子进程，并在空闲达到 `idleTimeoutMs` 后停止子进程。尚未完成的 HTTP 响应或打开的 WebSocket 会保留租约，因此正在使用的子进程不会被驱逐。网关关闭时会终止它拥有的全部子进程。

生成的命名租户 patch 会把默认空间的 `.credentials.yaml` 配置成只读 `fallback-file`，优先级低于租户本地凭据文档。提供方解析顺序为环境、租户本地文件、默认后备、`.env`。「模型」页仍然只写入和删除租户本地文档，因此覆盖仅对当前标识符生效；删除后无需复制机密即可恢复继承。两个文件都会被监视；若后备变更被更强来源遮蔽，就不发布生效值更新事件。

网关为设置导航提供三条所有者路由：`/__dsh_tenant/current` 只返回当前浏览器的选择，`/__dsh_tenant/reset` 清除选择并重新打开选择器，`/__dsh_tenant/default` 直接选择默认空间。「通用设置」行通过第一条路由探测能力，普通 `dsh web` 下保持隐藏，也从不枚举标识符。

选择器用于路由，而不是身份认证。网关只接受 loopback 绑定，在私有转发链路上移除选择器 Cookie 与浏览器 Origin 请求头，并要求远程部署由外层反向代理提供 TLS 与身份认证。知道其他标识符的用户仍可选择它；由于各子进程运行在同一个 OS 账户下，恶意代码遏制仍由沙箱策略负责。

## Directory-picker confinement

browse 后端接受可选的 `browseRoot`。配置后，省略路径会从该处开始，面包屑止于该处，realpath 规范化后的列举与目录创建如果越界就会失败。空白 `uploadRoot` 先跟随 `browseRoot`，否则使用宿主账户家目录。自适应选择器仅在挂载 browse 后端时转发 `browseRoot` 与 `uploadRoot`，因此租户 patch 可以约束远程浏览，而不改变 native 选择器语义。

## Verification

纯函数测试固定规范化、规范 Cookie 编码、哈希路径布局与阻塞选择器。CLI 测试固定参数解析和数值边界。browse 后端测试固定根面包屑、外部路径与符号链接逃逸拒绝、目录创建和上传默认行为；真实 Loader 组合测试固定自适应转发。凭据提供方测试固定后备优先级、本地覆盖／删除、权限检查和生效值热重载事件。浏览器验收会在两个标识符与留空默认空间下创建 workspace 和对话，使用各自 Cookie 重新连接，观察互不相交的 workspace／会话列表和根目录，验证默认 Key 继承与本地覆盖恢复，并实际操作两条设置导航路径。

## Alternatives considered

**只在浏览器中过滤 workspace 与会话。** 拒绝，因为 Host API 与 WebSocket 流仍然共享；每个新端点都会成为另一个潜在的跨标识符泄漏点。

**在同一进程的每项服务和持久化记录中增加租户字段。** 拒绝，因为 workspace、会话、设置、凭据、附件、preset、工具和未来插件都需要传播请求级租户；遗漏任何单例或后台任务都会破坏隔离声明。

**把标识符放入 URL 前缀。** 拒绝，因为应用目前会产生以来源根为基准的 API、插件与 WebSocket 绝对路径。Cookie 无需改写组装后的客户端，即可让所有传输继续使用现有协议。

## Consequences

进程与文件系统所有权让留空默认兼容和命名租户隔离都能在启动边界审计，而不依赖完整的端点过滤。代价是每个活跃标识符占用一个 Node 进程、首次使用存在启动延迟，并且浏览器 Cookie 作用于整个来源：切换标识符会影响该来源下的所有标签页。提供方凭据按部署选择从默认空间继承，但仍可独立覆盖；其他设置继续保持隔离。该机制不承诺同一 OS 账户下恶意用户之间的安全隔离。
