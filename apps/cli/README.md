# `@deepseek-ai/dsh`

English | [中文](README.zh.md)

The `dsh` command is the product launcher for profiles: ordered stacks of plugin-bundle patch layers under the user's own overrides. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

| Command | Purpose |
|---|---|
| `dsh --profile <name>` | Boot the named profile under `$DSH_HOME/profiles/<name>`. |
| `dsh --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `dsh web` | Alias of `--profile web`. |
| `dsh tenant-web` | Serve a blocking browser-identifier selector and one isolated Web child per identifier. |
| `dsh plugin --profile <name> <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory. |

The invoking directory is the default workspace root for ordinary profile boots and the blank `tenant-web` selection. A named tenant receives a private working directory and Harness home below the configured tenant root. The `web` and `headless` profiles auto-initialize on first use from shipped templates; any other profile must be created through `dsh plugin`.

## Identifier-isolated Web

`dsh tenant-web` serves an inline, blocking selector before the Harness application. A blank identifier routes to the ordinary default Web data; each normalized non-blank identifier starts a loopback-only `dsh web` child with separate `HOME`, `DSH_HOME`, workspace root, settings, and session persistence. The browser session cookie selects the child for HTTP, SSE, and WebSocket requests. Named tenants inherit provider API keys from the default space until Models stores a local override; values are read through a fallback layer, never copied. General settings shows the current identifier, a reselect action, and — for named tenants — a direct return to default. This mechanism isolates product data but does not authenticate identifiers, so the gateway binds loopback only and requires an authenticated outer reverse proxy for remote access. The [CLI behavior reference](reference/README.md#tenant-web-gateway) owns routes, flags, lifecycle, and limits.

The stock Web profile also loads the skin-center bundle. Open **Settings → Skin Center** to preview and apply any of the 11 shipped skins: Blue Fantasy, Dragon Heir, Harbor, Maid Atelier, Matrix, Miku, Minecraft, Trading, Whale Mom, Whale Song, and XP. Under `tenant-web`, the selection is stored in that identifier's own profile, so identifiers may use different skins. `--default-skin maid-atelier` applies the Deep Whale-derived Maid Atelier skin once when each identifier first starts; a later user choice is retained across gateway restarts.

## App arguments

The launcher parses only its own flags and hands everything after them to the booted profile, where any injected app plugin may parse the shared immutable snapshot ([`dsh-cmdline`](../../packages/boot/cmdline/README.md)). Launcher flags therefore come first, and the first token the launcher does not recognize starts the app's arguments:

```sh
dsh --profile web --port 8080       # --port belongs to the web app
dsh --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
dsh --profile headless "run the tests"
dsh --profile web --help            # the web app's flags, not the launcher's
dsh --help                          # the launcher's own help
```

## Profiles

A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

The tree composes over an empty root:
- each bundle's patch in `dsh.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `dsh.profile.bundles` resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.

Use `--dump-default-config` and `--dump-config` to inspect the composed tree without booting it.

The [CLI behavior reference](reference/README.md) owns exact layer precedence, flags, shutdown behavior, deployment defaults, and source execution.

## Development

Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm dsh <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.
