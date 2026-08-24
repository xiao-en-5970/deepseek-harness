# Agent Note: Web workspace file explorer

Status: implemented

English | [中文](2026-08-14-workspace-file-explorer.zh.md)

## Problem

The Web workspace picker registered directories but did not provide a persistent file tree, routine file and directory creation, direct downloads, or a convenient folder upload path inside the selected workspace.

## Decision

The Web application keeps a collapsible file explorer on the right side of the desktop layout and exposes it as a full-screen mobile panel. It lists the current workspace, creates files and directories, uploads files or folders in bounded batches, and downloads files or generated directory archives through Host APIs confined to the registered workspace.

All Host path operations resolve beneath the selected workspace, reject traversal and symbolic-link escapes, and apply request and archive limits at the complete-result boundary. Uploads preserve relative paths and report per-entry conflicts instead of replacing existing files implicitly.

## Alternatives considered

**Reuse only the workspace picker.** The picker selects a root but does not support ongoing navigation and file operations.

**Expose arbitrary Host paths.** Direct Host browsing would bypass workspace confinement and tenant expectations.

**Require command-line tools for every operation.** Shell-only workflows do not cover browser uploads or mobile use.

## Consequences

Users can manage the active workspace without leaving the conversation, and the same API supports desktop and mobile layouts. Directory downloads require bounded archive generation, and large uploads are split into multiple requests instead of one oversized payload.
