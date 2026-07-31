export interface BudgetRecord {
  readonly day: string // local 'YYYY-MM-DD'
  readonly bytes: number
  readonly count: number
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar day for an epoch-ms instant, 'YYYY-MM-DD'. */
export function localDay(nowMs: number): string {
  const d = new Date(nowMs)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today's record: the input if its day is today, else a zeroed record for today. */
export function freshRecord(record: BudgetRecord | null, nowMs: number): BudgetRecord {
  const day = localDay(nowMs)
  if (record && record.day === day) return record
  return { day, bytes: 0, count: 0 }
}

/** freshRecord(record, now) then add the completion's bytes and count. */
export function addCompletion(
  record: BudgetRecord | null,
  nowMs: number,
  bytes: number,
  count: number,
): BudgetRecord {
  const base = freshRecord(record, nowMs)
  return { day: base.day, bytes: base.bytes + bytes, count: base.count + count }
}
