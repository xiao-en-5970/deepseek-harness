# `@deepseek-ai/dsh`

[English](README.md) | 中文

`dsh` 是 DeepSeek Harness 中用于启动 profile 的命令；profile 由多个插件组合包 patch 层按顺序叠加而成，其上再应用用户自己的覆盖配置。[`src/args.ts`](src/args.ts) 负责命令语法，[`src/bin.ts`](src/bin.ts) 只加载选中的运行器。无效命令、来自其他模式的选项、配置错误和启动失败都会以非零状态退出。

## 入口模式

| 命令 | 用途 |
|---|---|
| `dsh --profile <name>` | 启动位于 `$DSH_HOME/profiles/<name>` 的指定 profile。 |
| `dsh --profile headless "job"` | 运行一个全新的持久化会话，打印最终答案并退出。 |
| `dsh web` | `--profile web` 的别名。 |
| `dsh tenant-web` | 提供阻塞式浏览器标识符选择器，并为每个标识符运行一个隔离的 Web 子进程。 |
| `dsh plugin --profile <name> <pnpm args>` | 通过在 profile 目录中转发给 pnpm 来管理该 profile 的插件。 |

运行普通 profile 或在 `tenant-web` 中留空标识符时，命令所在目录是默认 workspace 根目录；命名租户则在配置的租户根目录下获得私有工作目录与 Harness home。`web` 和 `headless` profile 在首次使用时会从随附模板自动初始化；其他任何 profile 都必须通过 `dsh plugin` 创建。

## 按标识符隔离的 Web

`dsh tenant-web` 会在 Harness 应用之前提供一个内联的阻塞式选择器。标识符留空时路由到普通的默认 Web 数据；每个经过规范化的非空标识符都会启动一个仅监听 loopback 的 `dsh web` 子进程，并使用独立的 `HOME`、`DSH_HOME`、workspace 根目录、设置和会话持久化。浏览器会话 Cookie 为 HTTP、SSE 与 WebSocket 请求选择子进程。命名租户在「模型」页保存本地覆盖之前会继承默认空间的提供方 API Key；值通过后备层原地读取，不会被复制。「通用设置」会显示当前标识符、重新选择入口，并为命名租户提供直接切回默认空间的入口。该机制隔离产品数据，但不对标识符进行身份认证，因此网关只绑定 loopback，远程访问必须置于经过认证的外层反向代理之后。路由、flag、生命周期和限制以 [CLI 行为参考](reference/README.md#tenant-web-gateway)为准。

随附 Web profile 还会加载皮肤中心组合包。打开「设置 → 皮肤中心」即可预览并应用随附的 11 套皮肤：Blue Fantasy、Dragon Heir、Harbor、Maid Atelier、Matrix、Miku、Minecraft、Trading、Whale Mom、Whale Song 和 XP。在 `tenant-web` 下，选择结果写入当前标识符自己的 profile，因此不同标识符可以使用不同皮肤。`--default-skin maid-atelier` 会在每个标识符首次启动时一次性应用源于 Deep Whale 的 Maid Atelier 皮肤；用户后续选择的皮肤会在网关重启后继续保留。

## 应用参数

启动器只解析自身的 flag，并将其后的所有内容交给已启动的 profile；注入该 profile 的任意应用插件都可以解析这份共享的不可变快照（[`dsh-cmdline`](../../packages/boot/cmdline/README.md)）。因此，启动器的 flag 必须写在最前面；启动器无法识别的第一个 token 标志着应用参数的开始：

```sh
dsh --profile web --port 8080       # --port belongs to the web app
dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
dsh --profile headless "run the tests"
dsh --profile web --help            # the web app's flags, not the launcher's
dsh --help                          # the launcher's own help
```

## Profile

profile 目录包含一个 `package.json`，其中记录树外插件依赖，以及 profile manifest（元数据清单）`dsh.profile` 和其中按顺序排列的 `bundles` 列表；还包含一个 `cordis.patch.yml`，其中保存用户自己的 patch 层。

配置树以空根为起点，依次叠加以下配置层：
- `dsh.profile.bundles` 中各组合包的 patch
- profile 自身的 `cordis.patch.yml`，然后是 home 级的 `$DSH_HOME/cordis.patch.yml`
- `--patch` 指定的覆盖层

`dsh.profile.bundles` 中列出的组合包先从 dsh 安装目录解析（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-headless`），再从 profile 自身的 `node_modules` 解析；pnpm 会将树外插件安装到该目录。

使用 `--dump-default-config` 和 `--dump-config` 可在不启动的情况下检查组合后的配置树。

层的确切优先级、flag、关闭行为、部署默认值和源码执行方式，以 [CLI（命令行界面）行为参考](reference/README.md)为准。

## 开发

生产运行需要已构建的包与前端产物。请在仓库根目录单独运行 `pnpm run build`，然后使用 `pnpm dsh <args...>` 运行 TypeScript 入口并转发所有参数；模块解析约定以[源码执行参考](reference/README.md#source-execution)为准。
