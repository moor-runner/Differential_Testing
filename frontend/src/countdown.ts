// 倒计时时长以秒为单位，最长 24 小时；上次设置的时长随布局保存在 layout.countdown。
export const countdownRange = { min: 1, max: 24 * 3600, initial: 30 * 60 };

/** 纯数字按分钟（"90"）；也接受 "分:秒"（"25:30"）与 "时:分:秒"（"1:30:00"），全角冒号同样有效。 */
export function parseCountdown(text: string): number | undefined {
  const parts = text.trim().replace(/：/g, ':').split(':');
  if (parts.length > 3 || parts.some(part => !/^\d{1,4}$/.test(part))) return undefined;
  const [first, ...rest] = parts.map(Number);
  if (rest.some(value => value >= 60)) return undefined;
  const seconds = parts.length === 1 ? first * 60 : parts.length === 2 ? first * 60 + rest[0] : first * 3600 + rest[0] * 60 + rest[1];
  return seconds >= countdownRange.min && seconds <= countdownRange.max ? seconds : undefined;
}

export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), rest = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export function readCountdown(layout: Record<string, unknown>): number {
  const value = Array.isArray(layout.countdown) && layout.countdown.length === 1 ? layout.countdown[0] : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= countdownRange.min && value <= countdownRange.max ? value : countdownRange.initial;
}
