# Agent Note: Identifier-isolated Web skins

Status: implemented

English | [中文](2026-08-18-identifier-isolated-web-skins.zh.md)

## Problem

The shared Web launcher needed a selectable full-page skin without allowing one tenant identifier's choice to change another identifier, overwrite an existing custom profile, or lose later user changes after restart.

## Decision

The stock Web profile mounts the `@linxin666/dsh-skins` catalog and Skin Center. Users preview and switch among 11 skins from **Settings → Skin Center**. `dsh tenant-web --default-skin maid-atelier` seeds Maid Atelier for a fresh tenant.

Every tenant identifier owns a separate `DSH_HOME` and Web profile, so Skin Center persists its managed layer independently. The default is a one-time seed: after the child loopback API applies the skin, the gateway verifies the served boot manifest and writes a versioned marker under that child's home. Restarts preserve later user selections.

Fresh Web profiles include the skin bundle. An installation-owned profile migrates only when its bundle list exactly matches the former stock tuple; custom bundle lists remain untouched. The launcher resolves the bundled skin directory for pnpm's deduplicated layout while respecting `DSH_SKINS_DIR`.

The pinned catalog includes Blue Fantasy, Dragon Heir, Harbor, Maid Atelier, Matrix, Miku, Minecraft, Trading, Whale Mom, Whale Song, and XP. Maid Atelier retains its bundled CC BY-NC-SA 4.0 attribution chain.

## Alternatives considered

**Store one global skin selection.** A global choice would violate tenant identifier isolation.

**Force the configured default at every restart.** Reapplying the seed would overwrite a user's later Skin Center selection.

**Rewrite every existing profile.** Blind migration would replace installation-owned custom bundle lists.

## Consequences

Each identifier receives an independent persistent skin and fresh identifiers receive a deployment default without sacrificing later choice. The launcher carries exact-tuple migration and a seed marker, and the non-commercial Maid Atelier license remains a deployment constraint.
