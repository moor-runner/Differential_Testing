import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, PlugZap, Settings2, X } from 'lucide-react';
import { api } from './api';
import { AiRequestStatus } from './AiRequestStatus';
import { useAiRequestProgress } from './useAiRequestProgress';

export function AiSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const titleId = useId();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | ''>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [testAttempted, setTestAttempted] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const tracking = useAiRequestProgress();
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    const abort = new AbortController();
    controller.current = abort;
    void api.aiSettings(abort.signal).then(settings => {
      setBaseUrl(settings.baseUrl); setModel(settings.model); setConfigured(settings.apiKeyConfigured);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取 AI 配置。'); }).finally(() => {
      if (!abort.signal.aborted) { setLoading(false); controller.current = null; }
    });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); element?.close(); };
  }, []);
  function close() { controller.current?.abort(); onClose(); }
  async function save(test: boolean) {
    if (loading || busy) return;
    if (!baseUrl.trim() || !model.trim()) { setError('请填写 API 地址和模型名称。'); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(test ? 'test' : 'save'); setError(''); setMessage('');
    if (test) { tracking.begin(); setTestAttempted(true); setTestMessage('正在保存本次连接测试配置…'); }
    try {
      const settings = await api.saveAiSettings({ baseUrl: baseUrl.trim(), model: model.trim(), ...(clearKey ? { clearApiKey: true } : key.trim() ? { apiKey: key.trim() } : {}) }, abort.signal);
      if (abort.signal.aborted) return;
      setBaseUrl(settings.baseUrl); setModel(settings.model); setConfigured(settings.apiKeyConfigured); setKey(''); setClearKey(false);
      onSaved?.();
      if (test) {
        setMessage('配置已保存，正在测试连接…');
        setTestMessage('配置已保存，正在提交连接测试请求…');
        const result = await api.testAiConnection(abort.signal, update => { if (mounted.current && controller.current === abort) tracking.update(update); });
        if (!abort.signal.aborted) { const success = result.message || `连接成功，模型：${result.model}`; setMessage(success); setTestMessage(success); tracking.record('AI 连接测试成功。'); }
      } else setMessage('AI 配置已保存。');
    } catch (reason) {
      if (!mounted.current) return;
      if (!abort.signal.aborted) { const failure = reason instanceof Error ? reason.message : test ? 'AI 连接测试失败。' : '保存 AI 配置失败。'; setError(failure); setMessage(test ? '连接测试失败，可查看处理记录后重试。' : '配置保存失败，请重试。'); if (test) { setTestMessage('连接测试失败，可查看处理记录后重试。'); tracking.record(failure, 'error'); } }
      else { setMessage('操作已取消。'); if (test) { setTestMessage('已取消连接测试。'); tracking.record('用户已取消连接测试。'); } }
    } finally {
      if (mounted.current && controller.current === abort) { controller.current = null; setBusy(''); if (test) tracking.finish(); }
    }
  }
  function cancel() { if (!controller.current || controller.current.signal.aborted) return; setMessage('正在取消操作…'); if (busy === 'test') { setTestMessage('正在取消连接测试，停止后台请求…'); tracking.record('已请求取消连接测试。'); } controller.current.abort(); }
  const disabled = loading || !!busy;
  return createPortal(<dialog ref={dialog} className="recognition-dialog ai-settings-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="recognition-heading"><div><h2 id={titleId}><Settings2 size={18} />AI 设置</h2><p>支持 OpenAI Chat Completions 格式的服务。</p></div><button className="icon-button" aria-label="关闭 AI 设置" onClick={close}><X size={19} /></button></div>
    <form className="ai-settings-form" onSubmit={event => { event.preventDefault(); void save(false); }}>
      <label>API 地址<input aria-label="API 地址" type="url" placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} value={baseUrl} disabled={disabled} onChange={event => { setBaseUrl(event.target.value); setMessage(''); }} /><small>填写服务的基础地址，例如 https://api.openai.com/v1。</small></label>
      <label>模型名称<input aria-label="模型名称" placeholder="服务支持的模型名称" autoComplete="off" spellCheck={false} value={model} disabled={disabled} onChange={event => { setModel(event.target.value); setMessage(''); }} /></label>
      <label>API Key<input aria-label="API Key" type="password" placeholder={configured ? '留空保留已保存的 Key' : '填写 API Key'} autoComplete="new-password" spellCheck={false} value={key} disabled={disabled || clearKey} onChange={event => { setKey(event.target.value); setMessage(''); }} /><small>{loading ? '正在读取配置…' : configured ? '已保存 Key；填写新值可替换。' : '尚未保存 Key。'} Key 保存在本机，界面不会回显。</small></label>
      {configured && <label className="ai-clear-key"><input type="checkbox" aria-label="清除已保存的 API Key" checked={clearKey} disabled={disabled} onChange={event => { setClearKey(event.target.checked); setMessage(''); }} />清除已保存的 API Key</label>}
      <p className="ai-transfer-note">整理时，题面文字将发送到此地址。保存配置不会发送请求；连接测试会向服务发送一条简短消息。</p>
      {error && <div className="recognition-error" role="alert">{error}</div>}
      <p className="ai-settings-status" role="status">{message || (loading ? '正在读取 AI 配置…' : '')}</p>
      {testAttempted && <AiRequestStatus {...tracking} busy={busy === 'test'} message={testMessage} />}
      <div className="ai-settings-actions"><button type="button" className="small-button" disabled={!!busy && controller.current?.signal.aborted} onClick={() => { if (busy) cancel(); else close(); }}>{busy ? '取消操作' : '关闭'}</button><button type="button" className="small-button" disabled={disabled} onClick={() => { void save(true); }}>{busy === 'test' ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}保存并测试</button><button type="submit" className="primary-button" disabled={disabled}>{busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存配置</button></div>
    </form>
  </dialog>, document.body);
}
