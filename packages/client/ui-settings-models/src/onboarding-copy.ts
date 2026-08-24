/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-15.2'

/** The complete editable Harness update timeline in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: 'Harness 更新历史',
    body: '2026-08-15 · 标准模式增强版：新会话首轮采用最小工具锚定，首次回复或工具调用后自动恢复完整标准能力。\n\n2026-08-15 · 图生图链路：Protocol v2 持久 worker、参考图校验与清理逻辑已修复。\n\n2026-08-15 · 稳定性：本地 Codex worker 改为 LaunchAgent 持久守护，异常退出自动拉起。\n\n2026-08-14 · 图像编辑：首次调用可稳定返回本地参考图编辑能力。',
    continueLabel: '开始使用',
  },
  en: {
    title: 'Harness Update Timeline',
    body: '2026-08-15 · Enhanced Standard: new sessions start with a minimal-tool anchor and restore the full Standard catalog after the first reply or tool call.\n\n2026-08-15 · Image workflow: Protocol v2 worker persistence and reference-image handling were fixed.\n\n2026-08-15 · Reliability: the local Codex worker now runs under a persistent LaunchAgent with automatic restart.\n\n2026-08-14 · Image editing: first-use reference-image editing is available again.',
    continueLabel: 'Get Started',
  },
} as const
