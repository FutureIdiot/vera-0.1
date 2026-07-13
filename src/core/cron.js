function parseNumber(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`invalid cron ${label}: ${value}`);
  return Number(value);
}

function parseField(source, min, max, label, { sundaySeven = false } = {}) {
  const values = new Set();
  const wildcard = source === "*";
  for (const part of source.split(",")) {
    if (!part) throw new Error(`invalid cron ${label}: ${source}`);
    const [base, rawStep, ...extra] = part.split("/");
    if (extra.length > 0) throw new Error(`invalid cron ${label}: ${part}`);
    const step = rawStep === undefined ? 1 : parseNumber(rawStep, label);
    if (step < 1) throw new Error(`invalid cron ${label} step: ${part}`);
    let start;
    let end;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2) throw new Error(`invalid cron ${label}: ${part}`);
      start = parseNumber(bounds[0], label);
      end = parseNumber(bounds[1], label);
    } else {
      start = parseNumber(base, label);
      end = start;
    }
    if (start < min || start > max || end < min || end > max || start > end) {
      throw new Error(`cron ${label} out of range: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(sundaySeven && value === 7 ? 0 : value);
  }
  return { values, wildcard };
}

export function parseFiveFieldCron(source) {
  if (typeof source !== "string") throw new Error("cron must be a five-field string");
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must contain exactly five fields");
  return {
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month"),
    dayOfWeek: parseField(fields[4], 0, 7, "day-of-week", { sundaySeven: true }),
  };
}

export function cronMatches(cron, date) {
  const dom = cron.dayOfMonth.values.has(date.getDate());
  const dow = cron.dayOfWeek.values.has(date.getDay());
  const dayMatches = cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
    ? true
    : cron.dayOfMonth.wildcard
      ? dow
      : cron.dayOfWeek.wildcard
        ? dom
        : dom || dow;
  return cron.minute.values.has(date.getMinutes())
    && cron.hour.values.has(date.getHours())
    && cron.month.values.has(date.getMonth() + 1)
    && dayMatches;
}
