export type Role = 'generator' | 'brute' | 'optimized';
export const roles: Role[] = ['generator', 'brute', 'optimized'];
export const roleLabels: Record<Role, string> = { generator: '生成器', brute: '暴力解', optimized: '优化解' };
export const roleDetails: Record<Role, string> = { generator: '种子 → 测试数据', brute: '输入 → 标准答案', optimized: '输入 → 待验证答案' };
export interface Settings { rounds: number; startSeed: string | null; parallelism: number; generatorTimeoutMs: number; bruteTimeoutMs: number; optimizedTimeoutMs: number }
// folderId 为 null 表示未分类。题目所在分类以列表摘要为准：自动保存不提交分类，移动题目使用单独接口。
export interface ProblemSummary { id: string; title: string; updatedAt: string; folderId: string | null }
export interface Problem extends Omit<ProblemSummary, 'folderId'> { statement: string; codes: Record<Role, string>; settings: Settings }
export interface Folder { id: string; name: string; collapsed: boolean; createdAt: string }
export interface ProcessResult { stdout: string; stderr: string; elapsedMs: number; exitCode: number | null; timedOut: boolean; outputLimited: boolean }
export type Verdict = 'PASS' | 'WA' | 'RE' | 'TLE' | 'OLE' | 'BRUTE_ERROR' | 'GENERATOR_ERROR' | 'CE' | 'CANCELLED' | 'INTERNAL_ERROR';
export interface CompileError { role: Role; output: string; diagnostics: { line: number; column: number; message: string }[] }
export interface Job { id: string; problemId: string; state: 'COMPILING' | 'RUNNING' | 'FINISHED'; verdict: Verdict | null; message: string; startedAt: string; completed: number; total: number; elapsedMs: number; roundsPerSecond: number; maxOptimizedMs: number; seed: string | null; round: number | null; input: string | null; generator: ProcessResult | null; brute: ProcessResult | null; optimized: ProcessResult | null; firstDifference: { line: number; expected: string; actual: string } | null; compileErrors: CompileError[]; codes: Record<Role, string>; settings: Settings }
export type Layout = Record<string, number[]>;
// 测试用例：题面样例从题面解析，自定义用例单独保存；expected 为空表示只运行不比对。
// compare 同时运行暴力解与优化解：优化解须与暴力解一致，给出期望输出时检查暴力解。
export type TestRole = 'brute' | 'optimized' | 'compare';
// source 为 ai 的用例由 AI 生成，其期望输出是 AI 推算的，需人工核对。
export interface TestCase { id: string; input: string; expected: string; source?: 'ai'; category?: string; note?: string }
export type TestVerdict = 'PASS' | 'WA' | 'RE' | 'TLE' | 'OLE' | 'UNCHECKED' | 'BRUTE_WA' | 'BRUTE_ERROR';
export interface LineDifference { line: number; expected: string | null; actual: string | null }
// 对比模式下顶层进程字段属于优化解，brute 为暴力解；firstDifference 比较暴力解与优化解，expectedDifference 比较期望与暴力解。
export interface TestCaseResult extends ProcessResult { verdict: TestVerdict; firstDifference: LineDifference | null; brute?: ProcessResult; expectedDifference?: LineDifference | null }
export interface TestRun { id: string; problemId: string; role: TestRole; verdict: 'PASS' | 'FAIL' | 'UNCHECKED' | 'CE' | 'CANCELLED' | 'INTERNAL_ERROR'; message: string; elapsedMs: number; timeoutMs: number; bruteTimeoutMs?: number; compileErrors: CompileError[]; results: (TestCaseResult | null)[] }
export interface Health { status: string; javaVersion: string; dataDir: string }
// 断点调试：每道题三份代码各自保存断点行号；调试运行暴力解或优化解的一个用例。
export type Breakpoints = Record<Role, number[]>;
export type DebugRole = 'brute' | 'optimized';
export type DebugState = 'STARTING' | 'RUNNING' | 'PAUSED' | 'TERMINATED';
// kind 决定着色；ref 为 0 表示不可展开；size/readable 为数组与集合的元素数（链式与哈希容器最多列出 readable 个）。
export interface DebugVariable { name: string; type: string; value: string; kind: 'null' | 'primitive' | 'string' | 'leaf' | 'array' | 'collection' | 'map' | 'object' | 'static'; ref: number; size?: number; readable?: number }
// line 为 -1 表示没有行号（本地方法、lambda 代理类）；methodStart/methodEnd 是方法内首末可执行行。
export interface DebugFrame { index: number; method: string; className: string; line: number; user: boolean; methodStart: number; methodEnd: number }
export interface DebugPause {
  reason: 'breakpoint' | 'step' | 'cursor' | 'exception' | 'pause'; thread: string;
  frames: DebugFrame[]; frameCount: number; frameIndex: number; line: number; variables: DebugVariable[];
  exception: { type: string; className: string; message: string; variable: DebugVariable } | null;
}
export type DebugVerdict = 'PASS' | 'WA' | 'RE' | 'OLE' | 'UNCHECKED' | 'STOPPED' | 'CE' | 'ERROR';
export interface DebugResult { verdict: DebugVerdict; message: string; exitCode: number | null; firstDifference: LineDifference | null; stdout: string; stdoutTruncated: boolean }
export interface DebugSnapshot {
  id: string; problemId: string | null; role: DebugRole; label: string; state: DebugState; version: number; generation: number; message: string; startedAt: string;
  pause: DebugPause | null; breakpoints: { line: number; verified: boolean }[]; result: DebugResult | null; compileErrors: CompileError[]; consoleLength: number;
}
export interface DebugConsoleChunk { stream: 'out' | 'err'; text: string }
export interface DebugConsoleDelta { from: number; length: number; truncated: boolean; chunks: DebugConsoleChunk[] }
export interface DebugChildren { start: number; size: number; readable: number; variables: DebugVariable[] }
declare global { interface Window { duipai?: { platform?: string; appVersion?: string; getInfo?: () => Promise<{ version: string; dataDir: string; javaVersion: string; logPath?: string }>; openDataDirectory?: () => Promise<unknown>; openBackendLog?: () => Promise<unknown>; isFullscreen?: () => Promise<boolean>; setFullscreen?: (value: boolean) => Promise<boolean>; onFullscreenChange?: (callback: (value: boolean) => void) => () => void; onBeforeClose?: (callback: () => Promise<void>) => () => void } } }
