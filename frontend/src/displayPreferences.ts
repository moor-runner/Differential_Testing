// 'edit' = 题面 + 单个编辑器；'duipai' = 题面 + 三个编辑器 + 运行结果。
export type View = 'edit' | 'duipai';
export const fontSizeRange = { min: 11, max: 24, initial: 14 };
const optimizedTab = 2;

export function readDisplayPreferences(layout: Record<string, unknown>) {
  const value = Array.isArray(layout.codeTab) && layout.codeTab.length === 1 ? layout.codeTab[0] : optimizedTab;
  const activeTab = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2 ? value : optimizedTab;
  const size = Array.isArray(layout.fontSize) && layout.fontSize.length === 1 ? layout.fontSize[0] : fontSizeRange.initial;
  const fontSize = typeof size === 'number' && Number.isInteger(size) && size >= fontSizeRange.min && size <= fontSizeRange.max ? size : fontSizeRange.initial;
  return { activeTab, fontSize };
}

/** Ctrl/Cmd + = / - / 0 adjusts code and statement text; other keys leave it unchanged. */
export function zoomFontSize(current: number, key: string): number | undefined {
  if (key === '=' || key === '+') return Math.min(fontSizeRange.max, current + 1);
  if (key === '-' || key === '_') return Math.max(fontSizeRange.min, current - 1);
  if (key === '0') return fontSizeRange.initial;
  return undefined;
}

export function tabDestination(index: number, key: string, count = 3): number | undefined {
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index + count - 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

export function visiblePane(activePane: number | undefined, count: number): number | undefined {
  return typeof activePane === 'number' && Number.isInteger(activePane) && activePane >= 0 && activePane < count ? activePane : undefined;
}
