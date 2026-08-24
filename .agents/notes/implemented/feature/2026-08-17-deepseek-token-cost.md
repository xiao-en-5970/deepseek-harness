# Agent Note: DeepSeek token cost attribution

Status: implemented

English | [中文](2026-08-17-deepseek-token-cost.zh.md)

## Problem

DeepSeek reports token usage per model request, but the Web application did not attribute estimated CNY cost to an answer, Session, workspace, or tenant identifier, and it did not expose the provider account balance without exposing credentials.

## Decision

The conversation UI prices every completed DeepSeek request from its streamed usage and request start time. A reply that invokes tools may contain several model steps, so its footer sums every priced step in that turn. The Session header shows complete measurements and account balance in wrapping metric groups.

Peak windows are `[09:00, 12:00)` and `[14:00, 18:00)` in Beijing time; off-peak rates are half of peak rates. Uncached input, cache-read input, cache-write input, and output remain disjoint, and `reasoningTokens` are descriptive members of `outputTokens` rather than an additional charge.

`deepSeekCost` is a token-meter Session projection. A final usage sample replaces an earlier same-step streamed sample, and its checkpoint survives paging and compaction. The browser aggregates workspace and identifier totals from tenant-local Session projections. The Host resolves the provider credential and returns only balance fields.

Only official DeepSeek routes and known model ids are priced. Compatibility ids `deepseek-chat` and `deepseek-reasoner` use the flash rate; unknown routes or models omit cost.

## Alternatives considered

**Use only the provider account balance.** A total balance cannot attribute cost to one answer, Session, workspace, or identifier.

**Recalculate from rendered text length.** Text length does not preserve cache buckets or authoritative output usage and would produce misleading totals.

## Consequences

Users receive deterministic local estimates and account-level remaining balance without browser access to provider credentials. Estimates depend on the checked-in price schedule and therefore require updates when DeepSeek changes prices or model ids; unknown prices remain absent instead of guessed.
