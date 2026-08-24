# Agent Note: 按标识符隔离的 Web 皮肤

Status: implemented

[English](2026-08-18-identifier-isolated-web-skins.md) | 中文

## Problem

共享 Web 启动器需要支持可选择的整页皮肤，同时不能让一个租户标识符的选择影响另一个标识符、覆盖已有自定义 profile，或在重启后丢失用户后续选择。

## Decision

随附 Web profile 挂载 `@linxin666/dsh-skins` 目录和皮肤中心。用户可在「设置 → 皮肤中心」预览并切换 11 套皮肤。`dsh tenant-web --default-skin maid-atelier` 会为新租户初始化 Maid Atelier。

每个租户标识符拥有独立的 `DSH_HOME` 和 Web profile，因此皮肤中心分别持久化其受管层。默认值只初始化一次：子进程 loopback API 应用皮肤后，网关验证实际启动 manifest，并在该子进程目录写入版本标记；后续重启保留用户选择。

新建 Web profile 包含皮肤 bundle。只有安装方托管 profile 的 bundle 列表与旧随附元组完全一致时才迁移；自定义列表保持不变。启动器为 pnpm 去重布局解析随附皮肤目录，同时尊重 `DSH_SKINS_DIR`。

锁定目录包含 Blue Fantasy、Dragon Heir、Harbor、Maid Atelier、Matrix、Miku、Minecraft、Trading、Whale Mom、Whale Song 和 XP。Maid Atelier 保留包内 CC BY-NC-SA 4.0 署名链。

## Alternatives considered

**保存一个全局皮肤选择。** 全局选择会破坏租户标识符隔离。

**每次重启都强制应用默认值。** 重复初始化会覆盖用户后来在皮肤中心作出的选择。

**重写所有已有 profile。** 无条件迁移会覆盖安装方维护的自定义 bundle 列表。

## Consequences

每个标识符获得独立持久的皮肤，新标识符获得部署默认值且仍可后续切换。启动器需要维护精确元组迁移和初始化标记；Maid Atelier 的非商业许可证仍是部署约束。
