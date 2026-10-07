export type Role = 'generator' | 'brute' | 'optimized';
export const roles: Role[] = ['generator', 'brute', 'optimized'];
export const roleLabels: Record<Role, string> = { generator: '生成器', brute: '暴力解', optimized: '优化解' };
export interface Settings { rounds: number; startSeed: string | null; parallelism: number; generatorTimeoutMs: number; bruteTimeoutMs: number; optimizedTimeoutMs: number }
export interface ProblemSummary { id: string; title: string; updatedAt: string }
export interface Problem extends ProblemSummary { statement: string; codes: Record<Role, string>; settings: Settings }
export interface ProcessResult { stdout: string; stderr: string; elapsedMs: number; exitCode: number | null; timedOut: boolean; outputLimited: boolean }
export type Verdict = 'PASS' | 'WA' | 'RE' | 'TLE' | 'OLE' | 'BRUTE_ERROR' | 'GENERATOR_ERROR' | 'CE' | 'CANCELLED' | 'INTERNAL_ERROR';
export interface CompileError { role: Role; output: string; diagnostics: { line: number; column: number; message: string }[] }
export interface Job { id: string; problemId: string; state: 'COMPILING' | 'RUNNING' | 'FINISHED'; verdict: Verdict | null; message: string; startedAt: string; completed: number; total: number; elapsedMs: number; roundsPerSecond: number; maxOptimizedMs: number; seed: string | null; round: number | null; input: string | null; generator: ProcessResult | null; brute: ProcessResult | null; optimized: ProcessResult | null; firstDifference: { line: number; expected: string; actual: string } | null; compileErrors: CompileError[]; codes: Record<Role, string>; settings: Settings }
export type Layout = Record<string, number[]>;
export interface Health { status: string; javaVersion: string; dataDir: string }
declare global { interface Window { duipai?: { platform?: string; appVersion?: string; getInfo?: () => Promise<{ version: string; dataDir: string; javaVersion: string; logPath?: string }>; openDataDirectory?: () => Promise<unknown>; openBackendLog?: () => Promise<unknown>; isFullscreen?: () => Promise<boolean>; setFullscreen?: (value: boolean) => Promise<boolean>; onFullscreenChange?: (callback: (value: boolean) => void) => () => void; onBeforeClose?: (callback: () => Promise<void>) => () => void } } }
