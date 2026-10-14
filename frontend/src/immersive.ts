// 沉浸编辑：在代码或题面里输入时上下边栏滑出视口，指针贴近窗口上/下边缘时以浮层滑回，类似 macOS 全屏的菜单栏。
// 这里只放与 DOM 无关的判断，便于单测；状态与事件在 useImmersive.ts。
export type Peek = 'top' | 'bottom' | null;
/** 呼出边栏的边缘热区高度（px）。 */
export const edgeSize = 6;

type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>;

/** 会改动文字的按键才算在编辑：可打印字符、删除、回车、Tab 与输入法组字；快捷键、方向键和功能键不算。 */
export function isEditingKey(event: Key): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.isComposing || event.key.length === 1 || ['Backspace', 'Delete', 'Enter', 'Tab', 'Process'].includes(event.key);
}

/**
 * 指针移动后应呼出的边栏。贴近窗口上沿呼出顶部边栏、贴近下沿呼出底部状态栏；已呼出时，
 * 指针仍在边栏覆盖范围内（顶部为 y ≤ reach，底部为 y ≥ reach）就保持，离开后返回 null。
 */
export function peekAt(current: Peek, y: number, height: number, reach: number): Peek {
  if (y < edgeSize) return 'top';
  if (y > height - edgeSize) return 'bottom';
  if (current === 'top' && y <= reach) return 'top';
  if (current === 'bottom' && y >= reach) return 'bottom';
  return null;
}
