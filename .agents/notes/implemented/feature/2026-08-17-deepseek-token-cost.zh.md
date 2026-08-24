# Agent Note: DeepSeek Token 花销归因

Status: implemented

[English](2026-08-17-deepseek-token-cost.md) | 中文

## Problem

DeepSeek 会返回每次模型请求的 Token 用量，但 Web 应用无法把预估人民币花销归因到单个回答、会话、工作区或租户标识符，也无法在不暴露凭据的前提下展示提供方账户余额。

## Decision

对话界面根据 DeepSeek 流式 usage 和请求开始时间为每个已完成请求计价。一个包含工具调用的回答可能有多个模型 step，因此回答尾部汇总该轮全部可计价 step。会话标题区域以可换行的完整指标组展示测量数据和账户余额。

北京时间高峰时段为 `[09:00, 12:00)` 和 `[14:00, 18:00)`，谷时单价为高峰的一半。非缓存输入、缓存命中输入、缓存写入和输出保持互斥口径；`reasoningTokens` 已包含于 `outputTokens`，不重复计费。

token-meter 注册 `deepSeekCost` 会话投影。同一 step 的最终 usage 会替换较早的流式样本，checkpoint 可跨分页和压缩保留。浏览器从当前租户的会话投影汇总工作区和标识符花销；Host 解析提供方凭据，只返回余额字段。

仅对 DeepSeek 官方路由和已知模型 id 计价。兼容 id `deepseek-chat` 与 `deepseek-reasoner` 使用 flash 费率；未知路由或模型不显示花销。

## Alternatives considered

**仅使用提供方账户余额。** 总余额无法归因到单个回答、会话、工作区或标识符。

**按渲染文本长度估算。** 文本长度无法保留缓存分桶和权威输出用量，会产生误导性总计。

## Consequences

用户无需让浏览器接触提供方凭据，就能获得确定性的本地预估和账户剩余余额。预估依赖仓库内价格表；DeepSeek 调整价格或模型 id 时必须同步更新，未知价格保持缺省而不猜测。
