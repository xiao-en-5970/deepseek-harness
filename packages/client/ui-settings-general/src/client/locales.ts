/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'tenant.title': '使用标识符',
  'tenant.current': '当前：{identifier}',
  'tenant.default': '默认空间',
  'tenant.description.default': '默认空间保存的 API Key 会供未单独配置的标识符使用。',
  'tenant.description.named': '未单独设置时使用默认空间的 API Key；在模型设置中保存后仅当前标识符生效。',
  'tenant.switch': '切换标识符',
  'tenant.useDefault': '切回默认空间',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'tenant.title': 'Identifier',
  'tenant.current': 'Current: {identifier}',
  'tenant.default': 'Default space',
  'tenant.description.default': 'API keys saved in the default space are inherited by identifiers without an override.',
  'tenant.description.named': 'Uses the default space API key until you save an override for this identifier in Models.',
  'tenant.switch': 'Switch identifier',
  'tenant.useDefault': 'Return to default',
} satisfies Record<SettingsKey, string>
