import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isEditingKey, peekAt, type Peek } from './immersive';

const typingSurface = '.editor-host, .statement-textarea';
// 焦点仍落在这些区域时保持沉浸：顶栏（呼出后可点击）、题面、编辑区（含标签栏与倒计时）以及 Monaco 自己的弹层。
const editingArea = '.topbar, .statement-panel, .editor-group, .monaco-editor, .context-view';
// 边栏里的菜单或编辑器弹出面板打开时不收回边栏；状态栏的问题列表是常驻面板，不算弹出。
const popupToggle = ':is(.topbar, .edge-bar-top, .edge-bar-bottom) [aria-expanded="true"]:not(.java-check-state)';
const hideDelay = 320, reachSlack = 8;

/** 顶部边栏呼出后覆盖到的位置：顶栏加题面/代码标签栏。 */
function topReach(shell: HTMLElement) {
  const header = shell.querySelector<HTMLElement>(':scope > .topbar')?.offsetHeight ?? 0;
  return header + Math.max(0, ...Array.from(shell.querySelectorAll<HTMLElement>('.edge-bar-top'), bar => bar.offsetHeight)) + reachSlack;
}
/** 底部状态栏呼出后覆盖到的位置；结果面板展开时状态栏在它上方，范围包含结果面板。 */
function bottomReach(shell: HTMLElement) {
  let reach = window.innerHeight;
  for (const bar of shell.querySelectorAll<HTMLElement>('.edge-bar-bottom')) {
    if (bar.offsetHeight && bar.parentElement) reach = Math.min(reach, bar.parentElement.getBoundingClientRect().bottom - bar.offsetHeight);
  }
  return reach - reachSlack;
}

/**
 * 编辑界面里在代码或题面中输入即进入沉浸编辑，上下边栏滑出视口；指针贴近窗口上/下边缘时以浮层呼出，
 * 离开后收回。未被编辑器使用的 Esc、切换界面，或焦点移到结果面板、题目列表、对话框时恢复常驻显示。
 */
export function useImmersive(enabled: boolean, shell: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const [peek, setPeek] = useState<Peek>(null);
  const peekRef = useRef<Peek>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const immersive = enabled && active;

  const cancelHide = useCallback(() => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } }, []);
  const reveal = useCallback((value: Peek) => { cancelHide(); peekRef.current = value; setPeek(value); }, [cancelHide]);

  useEffect(() => { if (!enabled) setActive(false); }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    // 捕获阶段：Monaco 处理退格、回车等按键后会停止冒泡。
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest(typingSurface) && isEditingKey(event)) { setActive(true); reveal(null); }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [enabled, reveal]);

  useEffect(() => {
    const root = shell.current;
    if (!immersive || !root) { reveal(null); return; }
    const holding = () => Array.from(root.querySelectorAll(popupToggle)).some(toggle => toggle.getClientRects().length > 0);
    const pointermove = (event: PointerEvent) => {
      if (event.buttons) return; // 拖选文字或拖动分隔条时不呼出
      const current = peekRef.current;
      const reach = current === 'top' ? topReach(root) : current === 'bottom' ? bottomReach(root) : 0;
      const next = peekAt(current, event.clientY, window.innerHeight, reach);
      if (next) { if (next === current) cancelHide(); else reveal(next); return; }
      if (!current || hideTimer.current || holding()) return;
      hideTimer.current = setTimeout(() => { hideTimer.current = null; if (!holding()) reveal(null); }, hideDelay);
    };
    // 指针快速移出窗口上沿（例如移向标题栏）时可能来不及经过热区，按离开的位置补判一次。
    const pointerleave = (event: PointerEvent) => { const edge = peekAt(null, event.clientY, window.innerHeight, 0); if (edge && !event.buttons) reveal(edge); };
    // 在编辑区按 Esc 退出沉浸；Monaco 用掉的 Esc（关闭补全、查找、取消选区等）会停止冒泡，到不了这里。
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target === document.body || (event.target instanceof Element && event.target.closest(typingSurface))) setActive(false);
    };
    const focusin = (event: FocusEvent) => { if (event.target instanceof Element && !event.target.closest(editingArea)) setActive(false); };
    window.addEventListener('pointermove', pointermove, { capture: true, passive: true });
    document.documentElement.addEventListener('pointerleave', pointerleave);
    window.addEventListener('keydown', escape);
    document.addEventListener('focusin', focusin);
    return () => {
      cancelHide();
      window.removeEventListener('pointermove', pointermove, { capture: true });
      document.documentElement.removeEventListener('pointerleave', pointerleave);
      window.removeEventListener('keydown', escape);
      document.removeEventListener('focusin', focusin);
    };
  }, [immersive, shell, reveal, cancelHide]);

  return { immersive, peek: immersive ? peek : null };
}
