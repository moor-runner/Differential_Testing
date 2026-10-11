import { tabDestination, type View } from './displayPreferences';

const choices: { view: View; text: string; label: string; title: string }[] = [
  { view: 'edit', text: '编辑', label: '编辑界面', title: '题面与单个编辑器' },
  { view: 'duipai', text: '对拍', label: '对拍界面', title: '题面、三个程序与运行结果' },
];

export function DisplayControls({ view, onChange, disabled }: { view: View; onChange: (view: View) => void; disabled?: boolean }) {
  return <div className="view-switch" role="group" aria-label="界面" onKeyDown={event => {
    if (disabled) return;
    const target = tabDestination(choices.findIndex(choice => choice.view === view), event.key, choices.length);
    if (target === undefined) return;
    event.preventDefault();
    onChange(choices[target].view);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[target]?.focus();
  }}>{choices.map(choice => <button key={choice.view} type="button" aria-label={choice.label} aria-pressed={view === choice.view} disabled={disabled} onClick={() => onChange(choice.view)} title={choice.title}>{choice.text}</button>)}</div>;
}
