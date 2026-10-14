import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, ChevronRight, Folder as FolderIcon, FolderOpen, FolderPlus, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { buildProblemTree, sortFolders } from './problemTree';
import { dateTime } from './Results';
import type { Folder, ProblemSummary } from './types';

const DRAG_TYPE = 'application/x-duipai-problem';
const UNGROUPED = '';
type Menu = { kind: 'problem'; problem: ProblemSummary; x: number; y: number } | { kind: 'folder'; folder: Folder; x: number; y: number } | null;

interface Props {
  summaries: ProblemSummary[]; folders: Folder[]; activeId: string | null; loading: boolean;
  /** 运行或其他操作进行中：不能切换或移动题目。 */
  locked: boolean;
  /** 不能新建题目或分类（未连接或进行中）。 */
  createDisabled: boolean;
  onSelect: (id: string) => void;
  /** 不指定分类时由调用方决定默认分类。 */
  onCreateProblem: (folderId?: string) => void;
  /** moveProblemId：新建后把这道题目移入新分类。 */
  onCreateFolder: (moveProblemId?: string) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onToggleFolder: (folder: Folder) => void;
  onMove: (problemId: string, folderId: string | null) => void;
}

export function ProblemSidebar({ summaries, folders, activeId, loading, locked, createDisabled, onSelect, onCreateProblem, onCreateFolder, onRenameFolder, onDeleteFolder, onToggleFolder, onMove }: Props) {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tree = useMemo(() => buildProblemTree(summaries, folders, query), [summaries, folders, query]);
  const grouped = folders.length > 0;

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [menu]);
  // 菜单在鼠标位置打开，超出窗口时向内收回。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => { if (locked) setMenu(null); }, [locked]);

  function menuAction(callback: () => void) { return () => { setMenu(null); callback(); }; }
  function openFolderMenu(folder: Folder, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    const anchor = event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : (() => { const rect = event.currentTarget.getBoundingClientRect(); return { x: rect.left, y: rect.bottom + 4 }; })();
    setMenu(current => current?.kind === 'folder' && current.folder.id === folder.id && event.type !== 'contextmenu' ? null : { kind: 'folder', folder, ...anchor });
  }
  function dropZone(folderId: string | null) {
    const key = folderId ?? UNGROUPED;
    const ours = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE);
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => { if (!ours(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(key); },
      onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(current => current === key ? null : current); },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!ours(event)) return;
        event.preventDefault(); setDropTarget(null);
        const id = event.dataTransfer.getData(DRAG_TYPE);
        if (id) onMove(id, folderId);
      },
    };
  }
  const item = (summary: ProblemSummary, nested: boolean) => <button className={`problem-item ${nested ? 'nested' : ''} ${activeId === summary.id ? 'active' : ''}`} key={summary.id} disabled={locked} onClick={() => onSelect(summary.id)} title={`${dateTime(summary.updatedAt)} 更新${grouped ? '，可拖到分类中' : ''}`}
    draggable={!locked} onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, summary.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropTarget(null)}
    onContextMenu={event => { event.preventDefault(); setMenu({ kind: 'problem', problem: summary, x: event.clientX, y: event.clientY }); }}>
    <span>{summary.title}</span><small>{dateTime(summary.updatedAt)}</small>
  </button>;
  const empty = !summaries.length && !folders.length;

  return <aside className="sidebar">
    <div className="sidebar-heading"><strong>题目<span>{summaries.length}</span></strong><div className="sidebar-actions">
      <button className="icon-button" title="新建分类" aria-label="新建分类" disabled={createDisabled} onClick={() => onCreateFolder()}><FolderPlus size={15} /></button>
      <button className="icon-button" title="新建题目" aria-label="新建题目" disabled={createDisabled} onClick={() => onCreateProblem()}><Plus size={15} /></button>
    </div></div>
    <label className="search-field"><Search size={13} /><input placeholder={grouped ? '搜索题目或分类' : '搜索'} value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索题目" />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={12} /></button>}</label>
    <div className="problem-list">
      {tree.folders.map(({ folder, problems, expanded }) => {
        const holdsActive = !expanded && problems.some(problem => problem.id === activeId);
        return <div key={folder.id} className={`folder-group ${dropTarget === folder.id ? 'drop-target' : ''}`} {...dropZone(folder.id)}>
          <div className={`folder-row ${holdsActive ? 'holds-active' : ''} ${menu?.kind === 'folder' && menu.folder.id === folder.id ? 'menu-open' : ''}`} onContextMenu={event => openFolderMenu(folder, event)}>
            <button className="folder-toggle" aria-expanded={expanded} title={folder.name} onClick={() => { if (!tree.searching) onToggleFolder(folder); }}>
              <ChevronRight size={12} className="folder-chevron" />{expanded ? <FolderOpen size={13} /> : <FolderIcon size={13} />}<span className="folder-name">{folder.name}</span><small>{problems.length}</small>
            </button>
            <button className="icon-button folder-more" aria-label={`分类操作：${folder.name}`} title="分类操作" aria-haspopup="menu" aria-expanded={menu?.kind === 'folder' && menu.folder.id === folder.id} onClick={event => openFolderMenu(folder, event)}><MoreHorizontal size={14} /></button>
          </div>
          {expanded && <div className="folder-children" role="group" aria-label={folder.name}>{problems.map(problem => item(problem, true))}{!problems.length && <div className="folder-empty">{tree.searching ? '没有匹配的题目' : '拖动题目到这里，或右键题目移动'}</div>}</div>}
        </div>;
      })}
      {grouped ? (!tree.searching || tree.ungrouped.length > 0) && <div className={`folder-group ungrouped ${dropTarget === UNGROUPED ? 'drop-target' : ''}`} {...dropZone(null)}>
        <div className="ungrouped-heading">未分类<small>{tree.ungrouped.length}</small></div>
        {tree.ungrouped.map(problem => item(problem, false))}{!tree.ungrouped.length && <div className="folder-empty">拖到这里移出分类</div>}
      </div> : tree.ungrouped.map(problem => item(problem, false))}
      {!loading && (empty ? <div className="sidebar-empty">还没有题目</div> : tree.searching && !tree.folders.length && !tree.ungrouped.length && <div className="sidebar-empty">没有匹配的题目</div>)}
    </div>
    {menu && <div ref={menuRef} className="menu sidebar-menu" role="menu" aria-label={menu.kind === 'folder' ? `分类：${menu.folder.name}` : `移动「${menu.problem.title}」`} style={{ left: menu.x, top: menu.y }}>
      {menu.kind === 'folder' ? <>
        <button role="menuitem" disabled={createDisabled} onClick={menuAction(() => onCreateProblem(menu.folder.id))}>在此分类新建题目</button>
        <button role="menuitem" onClick={menuAction(() => onRenameFolder(menu.folder))}>重命名分类</button>
        <div className="menu-separator" />
        <button role="menuitem" className="danger" onClick={menuAction(() => onDeleteFolder(menu.folder))}>删除分类</button>
      </> : <>
        <div className="menu-note">移动到</div>
        {[{ id: null, name: '未分类' }, ...sortFolders(folders)].map(target => {
          const current = (folders.some(folder => folder.id === menu.problem.folderId) ? menu.problem.folderId : null) === target.id;
          return <button role="menuitemradio" aria-checked={current} key={target.id ?? UNGROUPED} disabled={locked} onClick={menuAction(() => { if (!current) onMove(menu.problem.id, target.id); })}><span className="menu-label">{target.name}</span>{current && <Check size={13} />}</button>;
        })}
        <div className="menu-separator" />
        <button role="menuitem" disabled={createDisabled} onClick={menuAction(() => onCreateFolder(menu.problem.id))}>新建分类并移入…</button>
      </>}
    </div>}
  </aside>;
}
