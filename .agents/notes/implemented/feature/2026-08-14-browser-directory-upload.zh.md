# Agent Note: Browser directory upload into a remote Workspace

Status: implemented

[English](2026-08-14-browser-directory-upload.md) | 中文

## Problem

浏览式目录选择器可以让远程浏览器选择 Host 上已有的路径，但浏览器本地文件不属于该文件系统。用户通过远程沙盒 URL 访问 Harness 时，如果不另用 CLI 传输，就无法把本地项目文件夹变成 Host Workspace。

## Decision

既有 `browse` 目录选择交互在列举与「新建文件夹」旁统一负责目录上传。其 capability 与 Host API 增加四个 unary 操作：`beginDirectoryUpload`、有序的 `writeDirectoryUpload` 分块、`completeDirectoryUpload` 和幂等的 `abortDirectoryUpload`。Client runtime 转发这些操作；既有 browse flow 渲染**上传本地文件夹**，读取 `webkitdirectory` 选择，保留每个文件相对根目录的路径，并采用 `begin` 返回的分块上限。`complete` 成功后走 flow 既有的 `onPicked` 路径，因此 Workspace 接纳与错误归属不会分叉。

Host 把一次目录选择当作有界事务。`begin` 校验声明的文件数与字节总数，把 realpath 规范化后的父目录限制在 `uploadRoot`（默认为 Host 账户家目录）下，并以不透明上传 id 创建隐藏 staging 根。每个分块必须是规范 base64，严格按已确认 offset 排序，独立受分块、单文件与总量上限约束，并写入隐藏临时文件。解码后分块默认值为 512 KiB；经过 base64 膨胀和 JSON 信封封装后，单次请求仍低于常见的 1 MiB 反向代理 body 上限。相对路径拒绝空段、绝对形态、点段、带分隔符的段以及跨符号链接的段。终结块只发布一个文件；`complete` 要求声明的文件数和字节数精确相符，再把 staging 根原子重命名为目标目录。在这次重命名之前，Workspace 路径并不存在。中止、空闲过期和正常插件卸载会移除未完成 staging 根；进程异常退出后即使有残留，也保留隐藏 staging 名称，绝不会被当作目标接纳。

四个上传 RPC 全部加入浏览器传输层的仅 loopback 特权集合。`trustedHosts` 是 DNS 重绑定与同源栅栏，不是身份认证，不能据此开放文件内容写入。远程部署只能通过带身份认证、再转发到 loopback 监听地址的反向代理暴露上传；普通 LAN trusted-host 直连会得到 HTTP 403。

## Alternatives considered

- **Nginx 或 sidecar 上传端点。** 拒绝，因为它会在 Harness 插件图之外分叉身份认证、上限、错误处理、Workspace 接纳和生命周期清理。该能力属于既有 browse capability 与 API 契约。
- **一次提交整个目录或整个文件的 JSON 请求。** 拒绝，因为 carrier 会缓冲 JSON，base64 又会放大载荷；大型本地项目会让单请求产生不必要的常驻内存与 body 上限峰值。Host 公布的分块让每次请求都有界。
- **在 RPC carrier 旁增加 multipart／原始流式路由。** 它能避开 base64 开销，但会引入第二套客户端传输并绕过类型化 request/result/error 纪律。分块 unary 路径足以覆盖当前远程沙盒场景；若实测吞吐确有需要，流式 carrier 仍可作为后续优化。
- **挂载或直接暴露浏览器机器的文件系统。** 浏览器不会授予远程 origin 环境性的本地文件系统挂载。File System Access handle 也是浏览器本地能力，仍需显式读取和传输；目录输入是本 flow 可用、由用户手势触发且较通用的边界。

## Consequences

- 远程用户可以把本地非空项目树上传到选中的 Host 目录，并直接打开成 Workspace，无需另用 CLI。
- 协议增加四个方法和一个类型化失败码（`directory-upload-failed`）；browse capability 实现方必须提供该事务。
- 配置控制上传根、分块大小、单文件字节、总字节、文件数与空闲时长。更小的分块会增加 RPC 次数，更大的分块会增加缓冲 JSON 与 base64 的内存成本。
- 浏览器目录输入不报告独立的空目录，因此只含空目录的分支会被省略。上传按顺序执行，标签页或进程中断后不续传；重试会开启新的隔离事务。
- base64 会增加网络和编解码开销；实现选择有界内存与单一类型化传输，而非最大吞吐。
