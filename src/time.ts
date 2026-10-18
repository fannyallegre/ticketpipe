// Times are shown in the computer's own time zone (e.g. Paris = UTC+02:00 in summer), never in raw UTC.

/** "14:31:40" in local time. */
export const localTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

/** "2026-10-17 14:31" in local time. */
export const localDateTime = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${localTime(d).slice(0, 5)}`;

/** "UTC+02:00" for the current time zone. */
export function utcOffsetLabel(d = new Date()) {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
