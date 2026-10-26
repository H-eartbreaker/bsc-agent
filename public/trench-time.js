// Creation-age filtering, in minutes. Shared by the browser and boundary tests.
export function readAgeRange(filter) {
  const read = (value) => {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('时间请输入大于或等于 0 的分钟数');
    return n;
  };
  const min = read(filter.minAge), max = read(filter.maxAge);
  if (min != null && max != null && min > max) throw new Error('Min 不能大于 Max，请调整时间范围');
  return { min, max };
}

export function matchesTokenAge(token, filter, now = Date.now()) {
  let range;
  try { range = readAgeRange(filter); } catch { return false; }
  const { min, max } = range;
  if (min == null && max == null) return true;
  const created = Number(token.createdAt);
  if (!Number.isFinite(created) || created <= 0) return false;
  const minutes = Math.max(0, now - created) / 60_000;
  return (min == null || minutes >= min) && (max == null || minutes <= max);
}
