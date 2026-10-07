export type DisplayMode = 'split' | 'tabs';

export function readDisplayPreferences(layout: Record<string, unknown>) {
  const mode = Array.isArray(layout.uiMode) && layout.uiMode.length === 1 && layout.uiMode[0] === 1 ? 'tabs' : 'split';
  const value = Array.isArray(layout.codeTab) && layout.codeTab.length === 1 ? layout.codeTab[0] : 0;
  const activeTab = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2 ? value : 0;
  return { mode: mode as DisplayMode, activeTab };
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
