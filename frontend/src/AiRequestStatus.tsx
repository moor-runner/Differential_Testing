import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { AiRequestSnapshot, AiTrackingNotice } from './api';

const seconds = (milliseconds: number) => (Math.max(0, milliseconds) / 1000).toFixed(1);

export function AiRequestStatus({ elapsedMs, snapshot, notices, busy, message }: { elapsedMs: number; snapshot: AiRequestSnapshot | null; notices: AiTrackingNotice[]; busy: boolean; message: string }) {
  const [logMessage, setLogMessage] = useState('');
  const [logPath, setLogPath] = useState('数据目录/backend.log');
  useEffect(() => {
    let active = true;
    void window.duipai?.getInfo?.().then(info => {
      if (!active) return;
      const path = 'logPath' in info && typeof info.logPath === 'string' ? info.logPath : info.dataDir ? `${info.dataDir}/backend.log` : '';
      if (path) setLogPath(path);
    }).catch(() => { /* The default location still helps when desktop info is unavailable. */ });
    return () => { active = false; };
  }, []);
  async function openLog() {
    setLogMessage('');
    try {
      const bridge = window.duipai;
      if (bridge && 'openBackendLog' in bridge && typeof bridge.openBackendLog === 'function') {
        const result = await bridge.openBackendLog();
        if (typeof result === 'string' && result) throw new Error(result);
        setLogMessage('已打开后台日志。');
      } else if (bridge?.openDataDirectory) {
        const result = await bridge.openDataDirectory();
        if (typeof result === 'string' && result) throw new Error(result);
        setLogMessage(`已打开数据目录，请查看 ${logPath}。`);
      } else setLogMessage(`请在本机查看日志：${logPath}`);
    } catch (reason) { setLogMessage(`无法打开后台日志：${reason instanceof Error ? reason.message : '打开失败'}。日志位置：${logPath}`); }
  }
  const phase = busy && !message.startsWith('正在取消') ? snapshot?.message || snapshot?.stage || message : message;
  const id = snapshot?.id || notices.find(item => item.id)?.id;
  const records = [...(snapshot?.logs || []), ...notices].sort((first, second) => first.elapsedMs - second.elapsedMs);
  const trackingError = [...notices].reverse().find(item => item.level === 'error');
  return <div className="ai-request-status" aria-label="AI 处理状态">
    <div className="ai-request-summary"><span role="status">{phase}</span><span>已耗时 {seconds(elapsedMs)} 秒{busy ? ' · 最长等待 150 秒' : ''}</span>{snapshot && <><span>已接收 {snapshot.receivedCharacters} 字符</span><span>{snapshot.firstResponseMs === null ? '尚未收到首响应' : `首响应 ${seconds(snapshot.firstResponseMs)} 秒`}</span>{snapshot.reasoningCharacters > 0 && <span>思考字符 {snapshot.reasoningCharacters}</span>}{snapshot.httpStatus !== null && <span>HTTP {snapshot.httpStatus}</span>}{snapshot.thinkingDisabled && <span>非思考模式</span>}</>}</div>
    {trackingError && <p className="ai-tracking-error">{trackingError.message}</p>}
    <details className="ai-request-details"><summary>处理记录</summary><div className="ai-request-log-heading"><span>{id ? `请求编号：${id}` : '本次请求尚无后台编号'}</span><button type="button" className="small-button" onClick={() => { void openLog(); }}><FileText size={13} />查看后台日志</button></div><ol aria-label="AI 处理记录">{records.length ? records.map((item, index) => <li key={`${item.elapsedMs}-${index}`} className={item.level === 'error' ? 'error' : ''}><time>{seconds(item.elapsedMs)} 秒</time><span>{item.level === 'error' ? '错误' : '信息'}</span><span>{item.message}</span></li>) : <li><span>正在等待本地服务的处理记录。</span></li>}</ol><p className="ai-log-location">日志位置：{logPath}</p>{logMessage && <p className="ai-log-feedback" role="status">{logMessage}</p>}</details>
  </div>;
}
