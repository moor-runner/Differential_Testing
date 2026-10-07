import { useCallback, useEffect, useRef, useState } from 'react';

export function useFullscreen(enabled: boolean, onError: (message: string) => void) {
  const [fullscreen, setFullscreen] = useState(false);
  const current = useRef(false);
  const pending = useRef(false);
  const syncGeneration = useRef(0);
  const apply = useCallback((value: boolean) => { current.current = value; setFullscreen(value); }, []);

  useEffect(() => {
    const desktop = window.duipai;
    if (desktop?.isFullscreen && desktop.onFullscreenChange) {
      let cancelled = false;
      const sync = () => {
        const generation = ++syncGeneration.current;
        void desktop.isFullscreen!().then(value => { if (!cancelled && generation === syncGeneration.current) apply(value); }).catch(() => undefined);
      };
      const unsubscribe = desktop.onFullscreenChange(sync);
      sync();
      return () => { cancelled = true; unsubscribe(); };
    }
    const changed = () => apply(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', changed);
    changed();
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [apply]);

  const changeFullscreen = useCallback(async (value: boolean) => {
    if (pending.current || (value && !enabled)) return;
    pending.current = true;
    try {
      if (window.duipai?.setFullscreen) {
        const generation = ++syncGeneration.current;
        const actual = await window.duipai.setFullscreen(value);
        if (generation === syncGeneration.current) apply(actual);
      }
      else {
        if (value) await document.documentElement.requestFullscreen();
        else if (document.fullscreenElement) await document.exitFullscreen();
        apply(!!document.fullscreenElement);
      }
    } catch (error) { onError(`切换全屏失败：${error instanceof Error ? error.message : '请重试'}`); }
    finally { pending.current = false; }
  }, [enabled, apply, onError]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'F11' || (event.key === 'Escape' && current.current)) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) void changeFullscreen(event.key === 'Escape' ? false : !current.current);
      }
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [changeFullscreen]);

  return { fullscreen, changeFullscreen };
}
