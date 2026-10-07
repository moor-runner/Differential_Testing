import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

export const javaShortcuts = [
  ['Ctrl+Space', '代码补全'],
  ['Ctrl+Alt+L', '整理代码缩进'],
  ['Alt+Enter', '快速修复 / 导入类'],
  ['Ctrl+B / F12', '跳转到当前文件的定义'],
  ['Ctrl+P', '方法参数提示'],
  ['Ctrl+F12', '当前文件结构'],
  ['Ctrl+D', '复制当前行 / 所选行'],
  ['Ctrl+Y', '删除当前行 / 所选行'],
  ['Ctrl+/', '切换行注释'],
  ['Ctrl+Shift+Z', '重做'],
  ['Ctrl+F / Ctrl+H', '查找 / 替换'],
  ['F2 / Shift+F2', '下一个 / 上一个问题'],
] as const;

export function attachJavaEditorActions(editor: monaco.editor.IStandaloneCodeEditor, toggleStructure: () => void): monaco.IDisposable {
  const ctrl = monaco.KeyMod.CtrlCmd;
  const actions: monaco.IDisposable[] = [];
  function bind(id: string, label: string, keybinding: number, builtin: string, editable = false) {
    actions.push(editor.addAction({
      id: `duipai.java.${id}`, label, keybindings: [keybinding],
      precondition: editable ? 'editorTextFocus && !editorReadonly' : 'editorTextFocus',
      run: () => { const action = editor.getAction(builtin); if (action) return action.run(); editor.trigger('java-shortcuts', builtin, null); },
    }));
  }
  bind('format', 'Java：整理代码缩进', ctrl | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, 'editor.action.formatDocument', true);
  bind('definition', 'Java：跳转到定义', ctrl | monaco.KeyCode.KeyB, 'editor.action.revealDefinition');
  bind('parameters', 'Java：方法参数提示', ctrl | monaco.KeyCode.KeyP, 'editor.action.triggerParameterHints');
  bind('duplicate', '复制当前行', ctrl | monaco.KeyCode.KeyD, 'editor.action.copyLinesDownAction', true);
  bind('deleteLine', '删除当前行', ctrl | monaco.KeyCode.KeyY, 'editor.action.deleteLines', true);
  bind('quickFix', 'Java：快速修复', monaco.KeyMod.Alt | monaco.KeyCode.Enter, 'editor.action.quickFix', true);
  bind('redo', '重做', ctrl | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, 'redo', true);
  bind('nextProblem', '下一个代码问题', monaco.KeyCode.F2, 'editor.action.marker.next');
  bind('previousProblem', '上一个代码问题', monaco.KeyMod.Shift | monaco.KeyCode.F2, 'editor.action.marker.prev');
  actions.push(editor.addAction({ id: 'duipai.java.structure', label: 'Java：当前文件结构', keybindings: [ctrl | monaco.KeyCode.F12], precondition: 'editorTextFocus', run: toggleStructure }));
  return { dispose: () => actions.forEach(action => action.dispose()) };
}
