import { Columns3, Maximize, PanelTop } from 'lucide-react';
import { tabDestination, type DisplayMode } from './displayPreferences';

export function DisplayControls({ mode, onChange, onFullscreen, disabled, fullscreenDisabled }: { mode: DisplayMode; onChange: (mode: DisplayMode) => void; onFullscreen: () => void; disabled?: boolean; fullscreenDisabled?: boolean }) {
  const choices: DisplayMode[] = ['split', 'tabs'];
  return <div className="display-controls" role="group" aria-label="显示模式" onKeyDown={event => {
    if (disabled) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const target = tabDestination(index < 0 ? choices.indexOf(mode) : index, event.key, buttons.length);
    if (target === undefined) return;
    event.preventDefault();
    if (target < choices.length) onChange(choices[target]);
    buttons[target].focus();
  }}><button type="button" aria-label="分栏模式" aria-pressed={mode === 'split'} disabled={disabled} onClick={() => onChange('split')} title="三个编辑器与运行结果同屏显示"><Columns3 size={13} />分栏模式</button><button type="button" aria-label="标签页模式" aria-pressed={mode === 'tabs'} disabled={disabled} onClick={() => onChange('tabs')} title="通过标签页切换单个编辑器，隐藏底部结果"><PanelTop size={13} />标签页模式</button><button type="button" aria-label="全屏模式" disabled={disabled || fullscreenDisabled} onClick={onFullscreen} title="只显示题目与编辑器，放大字体（F11；Esc 退出）"><Maximize size={13} />全屏模式</button></div>;
}
