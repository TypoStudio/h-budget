import { gs } from './google'
import type { Category, Entry, Kind } from '../types'

/**
 * 단일 저장소: '가계부' 시트가 곧 데이터베이스다.
 * - 항목 = 열 (이름·순서·구분은 헤더와 그룹 행에서, 합산제외/숨김은 헤더 셀 메모로)
 * - 기록 = 월 행의 셀 (수식은 시트 수식 그대로, 메모는 셀 메모로)
 * - 계산 열(월급/잔고/지출합계/카드합계)은 항목으로 취급하지 않는다
 * 앱이 만든 시트(관리 시트: 지출합계·잔고만 있는 형태)는 구조가 바뀔 때
 * 그룹 라벨과 합계·잔고·이월 수식을 앱이 다시 써서 시트 단독으로도 계산이 맞게 유지한다.
 */
export const LEDGER = '가계부'
/** 이월잔고 수동 입력을 나타내는 예약 항목 ID */
export const CARRYOVER_ID = '__이월__'
const COMPUTED = ['월급', '잔고', '지출합계', '카드합계']
const RANGE = `${LEDGER}!A2:AZ1000`

export function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function parseSpreadsheetId(input: string): string | null {
  const m = input.match(/\/d\/([a-zA-Z0-9-_]+)/)
  if (m) return m[1]
  const t = input.trim()
  if (/^[a-zA-Z0-9-_]{20,}$/.test(t)) return t
  return null
}

export async function createSpreadsheet(): Promise<string> {
  const res = await gs.create('가계부')
  return res.spreadsheetId as string
}

/** 0 기반 열 인덱스 → A1 열 문자 */
function a1(c: number): string {
  return c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26))
}

/** 셀 수식이 단순 사칙연산(=1000+2000)이면 = 뗀 수식을, 아니면 undefined */
function arithFormula(raw: unknown): string | undefined {
  const f = String(raw ?? '')
  if (!f.startsWith('=')) return undefined
  const expr = f.slice(1).replace(/\s/g, '')
  return /^[0-9+\-*/().]+$/.test(expr) ? expr : undefined
}

/** 기존 월 라벨 형식을 따라 새 월 라벨을 만든다 (예: "2026. 7" → "2026. 8") */
function monthLabel(template: string, month: string): string {
  const [y, mo] = month.split('-')
  const dm = template.match(/(\d{4})([-./\s]*)(\d{1,2})/)
  if (!dm) return month
  return template.replace(dm[0], `${y}${dm[2]}${dm[3].length === 2 ? mo : String(Number(mo))}`)
}

interface Ctx {
  id: string
  sheetId: number
  /** 시트 3행 헤더 (인덱스 = 열) */
  headers: string[]
  expenseStart: number
  carryCol: number
  /** 앱이 수식을 관리하는 시트인지 (지출합계·잔고만 있는 생성형 구조) */
  managed: boolean
  colOf: Map<string, number>
  /** 월 → 시트 행 번호(1 기준) */
  rowOf: Map<string, number>
  labelOf: Map<string, string>
  cats: Category[]
}
let ctx: Ctx | null = null

function need(): Ctx {
  if (!ctx) throw new Error('스프레드시트가 연결되지 않았습니다.')
  return ctx
}

/** 연결 진입점: 시트가 없으면 뼈대를 만들고, 예전 앱 탭이 있으면 마이그레이션 후 로드 */
export async function openSpreadsheet(id: string): Promise<{ title: string; categories: Category[]; entries: Entry[] }> {
  const meta = await gs.meta(id)
  const titles: string[] = meta.sheets.map((s: { properties: { title: string } }) => s.properties.title)
  if (!titles.includes(LEDGER)) {
    await gs.batchUpdate(id, [{ addSheet: { properties: { title: LEDGER } } }])
    await gs.batchSetValues(
      id,
      [{ range: `${LEDGER}!A2`, values: [['', '', '지출', ''], ['월', '이월잔고', '지출합계', '잔고']] }],
      'RAW',
    )
  }
  let data = await loadAll(id)
  if (titles.includes('가계부앱_항목')) {
    await migrateAppSheets(id)
    data = await loadAll(id)
  }
  return { title: meta.properties.title, ...data }
}

export async function loadAll(id: string): Promise<{ categories: Category[]; entries: Entry[] }> {
  const meta = await gs.meta(id)
  const sheet = (meta.sheets as { properties: { title: string; sheetId: number } }[]).find(
    (s) => s.properties.title === LEDGER,
  )
  if (!sheet) throw new Error(`'${LEDGER}' 시트를 찾지 못했습니다.`)
  const [raw, formulaRes, noteRes] = await Promise.all([
    gs.getValues(id, RANGE, 'raw'),
    gs.getValues(id, RANGE, 'formula').catch(() => null),
    gs.getNotes(id, RANGE).catch(() => null),
  ])
  const rows = (raw.values ?? []) as unknown[][]
  const formulas = (formulaRes?.values ?? []) as unknown[][]
  const noteRows = (noteRes?.sheets?.[0]?.data?.[0]?.rowData ?? []) as { values?: { note?: string }[] }[]
  const note = (r: number, c: number) => noteRows[r]?.values?.[c]?.note?.trim() || undefined

  const groups = rows[0] ?? []
  const headers = (rows[1] ?? []).map((h) => String(h ?? '').trim())
  let expenseStart = headers.length
  for (let c = 0; c < groups.length; c++) {
    if (String(groups[c] ?? '').trim() === '지출') {
      expenseStart = c
      break
    }
  }
  let carryCol = -1
  const categories: Category[] = []
  const colOf = new Map<string, number>()
  // 다시 불러와도 진행 중인 화면 상태가 끊기지 않도록 이전 스냅샷과 이름+구분으로 id를 유지
  const prev = ctx?.id === id ? [...ctx.cats] : []
  for (let c = 1; c < headers.length; c++) {
    const name = headers[c]
    if (!name || COMPUTED.includes(name)) continue
    if (name === '이월잔고') {
      carryCol = c
      continue
    }
    const kind: Kind = c < expenseStart ? '수입' : '지출'
    const pi = prev.findIndex((p) => p.name === name && p.kind === kind)
    const catId = pi >= 0 ? prev.splice(pi, 1)[0].id : newId()
    const hn = note(1, c) ?? ''
    categories.push({ id: catId, kind, name, excluded: hn.includes('합산제외'), hidden: hn.includes('숨김'), order: c })
    colOf.set(catId, c)
  }

  const rowOf = new Map<string, number>()
  const labelOf = new Map<string, string>()
  const entries: Entry[] = []
  for (let r = 2; r < rows.length; r++) {
    const label = String(rows[r]?.[0] ?? '')
    const dm = label.match(/(\d{4})[-./\s]*(\d{1,2})/)
    if (!dm) continue
    const month = `${dm[1]}-${dm[2].padStart(2, '0')}`
    if (rowOf.has(month)) continue
    rowOf.set(month, r + 2)
    labelOf.set(month, label)
    for (const cat of categories) {
      const c = colOf.get(cat.id)!
      const v = rows[r]?.[c]
      if (typeof v !== 'number') continue
      entries.push({ month, categoryId: cat.id, amount: v, memo: note(r, c), formula: arithFormula(formulas[r]?.[c]) })
    }
    // 이월잔고: 순수 값·사칙연산 수식은 수동 입력, 셀 참조 수식(=G4 등)은 자동 계산
    if (carryCol >= 0) {
      const v = rows[r]?.[carryCol]
      const rawF = String(formulas[r]?.[carryCol] ?? '')
      const f = arithFormula(rawF)
      if (typeof v === 'number' && (!rawF.startsWith('=') || f))
        entries.push({ month, categoryId: CARRYOVER_ID, amount: v, formula: f })
    }
  }

  const managed =
    headers.includes('지출합계') && headers.includes('잔고') && !headers.includes('월급') && !headers.includes('카드합계')
  ctx = { id, sheetId: sheet.properties.sheetId, headers, expenseStart, carryCol, managed, colOf, rowOf, labelOf, cats: categories }
  return { categories, entries }
}

/** 월 행이 없으면 이웃 월 행 자리에 삽입하고 시트 행 번호를 돌려준다 */
async function ensureMonthRow(month: string): Promise<number> {
  const c = need()
  const got = c.rowOf.get(month)
  if (got) return got
  // 시트가 최신월을 위에 두는 내림차순인지 보고 같은 방향으로 끼워 넣는다.
  // 방향은 이웃한 월 행끼리 비교해 다수결로 판단 (중간에 어긋난 행이 있어도 견딘다)
  const byRow = [...c.rowOf.entries()].sort((a, b) => a[1] - b[1])
  let down = 0
  for (let i = 1; i < byRow.length; i++) down += byRow[i][0] < byRow[i - 1][0] ? 1 : -1
  // 다수결이 갈리면(잘못 끼어든 행이 있을 때) 맨 위·맨 아래 월의 전체 추세로 결정하고,
  // 판단할 행이 없으면 최신월이 위로 오는 내림차순을 기본으로 한다
  const desc = down !== 0 ? down > 0 : byRow.length < 2 || byRow[0][0] > byRow[byRow.length - 1][0]
  // 새 행 바로 위에 와야 할 월 = 정렬 방향상 이 월보다 앞에 오는 마지막 월
  let above: [string, number] | undefined
  for (const it of byRow) if (desc ? it[0] > month : it[0] < month) above = it
  const template = above ?? byRow[0]
  const destRow = above ? above[1] + 1 : byRow.length ? byRow[0][1] : 4
  const requests: unknown[] = [
    {
      insertDimension: {
        range: { sheetId: c.sheetId, dimension: 'ROWS', startIndex: destRow - 1, endIndex: destRow },
        // 맨 위에 넣을 때는 헤더가 아니라 아래 행의 서식을 물려받아야 한다
        inheritFromBefore: !!above && destRow > 4,
      },
    },
  ]
  const srcRow = template ? (template[1] >= destRow ? template[1] + 1 : template[1]) : undefined
  if (!c.managed && srcRow !== undefined)
    // 일반 시트: 이웃 행을 복사해 그 시트 고유의 수식(잔고 등)을 상대 참조로 물려받는다
    requests.push({
      copyPaste: {
        source: { sheetId: c.sheetId, startRowIndex: srcRow - 1, endRowIndex: srcRow, startColumnIndex: 0, endColumnIndex: 60 },
        destination: { sheetId: c.sheetId, startRowIndex: destRow - 1, endRowIndex: destRow, startColumnIndex: 0, endColumnIndex: 60 },
        pasteType: 'PASTE_NORMAL',
      },
    })
  await gs.batchUpdate(c.id, requests)
  for (const [m, r] of c.rowOf) if (r >= destRow) c.rowOf.set(m, r + 1)
  c.rowOf.set(month, destRow)
  const label = c.managed ? month : monthLabel(template ? c.labelOf.get(template[0]) ?? '' : '', month)
  c.labelOf.set(month, label)
  const writes: { range: string; values: unknown[][] }[] = [{ range: `${LEDGER}!A${destRow}`, values: [[label]] }]
  if (!c.managed && srcRow !== undefined)
    for (const col of c.colOf.values()) writes.push({ range: `${LEDGER}!${a1(col)}${destRow}`, values: [['']] })
  await gs.batchSetValues(c.id, writes, 'RAW')
  if (c.managed) await rewriteManaged()
  return destRow
}

/** 관리 시트의 그룹 라벨(2행)을 현재 열 배치에 맞게 다시 쓴다 */
async function rewriteGroups(): Promise<void> {
  const c = need()
  if (!c.managed) return
  const row: unknown[] = Array(c.headers.length).fill('')
  const incCols = c.cats.filter((k) => k.kind === '수입').map((k) => c.colOf.get(k.id)!)
  const expCols = c.cats.filter((k) => k.kind === '지출').map((k) => c.colOf.get(k.id)!)
  if (incCols.length) row[Math.min(...incCols)] = '수입'
  const sumCol = c.headers.indexOf('지출합계')
  const expStart = expCols.length ? Math.min(...expCols) : sumCol
  if (expStart >= 0) row[expStart] = '지출'
  await gs.batchSetValues(c.id, [{ range: `${LEDGER}!A2`, values: [row] }], 'RAW')
  c.expenseStart = expStart >= 0 ? expStart : c.headers.length
}

/** 관리 시트의 지출합계·잔고·이월(자동) 수식을 모든 월 행에 다시 쓴다 */
async function rewriteManaged(): Promise<void> {
  const c = need()
  if (!c.managed) return
  const sumCol = c.headers.indexOf('지출합계')
  const balCol = c.headers.indexOf('잔고')
  if (sumCol < 0 || balCol < 0) return
  const months = [...c.rowOf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  if (!months.length) return
  // 이월 셀이 값(수동 입력)이거나 사용자가 쓴 수식이면 건드리지 않는다 — 자동 패턴(=잔고N)과 빈 칸만 재작성
  let carryFs: unknown[][] = []
  if (c.carryCol >= 0)
    carryFs = ((await gs.getValues(c.id, `${LEDGER}!${a1(c.carryCol)}1:${a1(c.carryCol)}1000`, 'formula')).values ??
      []) as unknown[][]
  const autoCarry = new RegExp(`^=${a1(balCol)}\\d+$`)
  const inc = c.cats.filter((k) => k.kind === '수입' && !k.excluded).map((k) => c.colOf.get(k.id)!)
  const exp = c.cats.filter((k) => k.kind === '지출' && !k.excluded).map((k) => c.colOf.get(k.id)!)
  const data: { range: string; values: unknown[][] }[] = []
  months.forEach(([, n], i) => {
    const sumExpr = exp.map((col) => `${a1(col)}${n}`).join('+')
    data.push({ range: `${LEDGER}!${a1(sumCol)}${n}`, values: [[sumExpr ? `=${sumExpr}` : 0]] })
    const incExpr = inc.map((col) => `${a1(col)}${n}`).join('+')
    const carryTerm = c.carryCol >= 0 ? `${a1(c.carryCol)}${n}` : '0'
    data.push({ range: `${LEDGER}!${a1(balCol)}${n}`, values: [[`=${carryTerm}${incExpr ? '+' + incExpr : ''}-${a1(sumCol)}${n}`]] })
    if (c.carryCol >= 0) {
      const cf = String(carryFs[n - 1]?.[0] ?? '')
      if (cf === '' || autoCarry.test(cf))
        data.push({
          range: `${LEDGER}!${a1(c.carryCol)}${n}`,
          values: [[i > 0 ? `=${a1(balCol)}${months[i - 1][1]}` : '']],
        })
    }
  })
  await gs.batchSetValues(c.id, data)
}

/** 헤더 셀 메모로 합산제외/숨김 플래그 저장 */
async function writeHeaderNote(cat: Category): Promise<void> {
  const c = need()
  const col = c.colOf.get(cat.id)
  if (col == null) return
  const text = [cat.excluded ? '합산제외' : '', cat.hidden ? '숨김' : ''].filter(Boolean).join(' ')
  await gs.batchUpdate(c.id, [
    {
      updateCells: {
        range: { sheetId: c.sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: col, endColumnIndex: col + 1 },
        rows: [{ values: [{ note: text }] }],
        fields: 'note',
      },
    },
  ])
}

/** 금액(또는 수식) 일괄 기록. amount가 null이면 셀을 비운다 */
export async function setAmounts(
  list: { month: string; categoryId: string; amount: number | null; formula?: string }[],
): Promise<void> {
  const c = need()
  const data: { range: string; values: unknown[][] }[] = []
  let carryTouched = false
  for (const it of list) {
    const row = await ensureMonthRow(it.month)
    const col = it.categoryId === CARRYOVER_ID ? c.carryCol : c.colOf.get(it.categoryId)
    if (col == null || col < 0) continue
    if (it.categoryId === CARRYOVER_ID) carryTouched = true
    data.push({
      range: `${LEDGER}!${a1(col)}${row}`,
      values: [[it.amount == null ? '' : it.formula ? `=${it.formula}` : it.amount]],
    })
  }
  if (data.length) await gs.batchSetValues(c.id, data)
  // 이월을 '자동으로' 되돌리면 관리 시트는 전월 잔고 수식을 복원한다
  if (carryTouched && c.managed) await rewriteManaged()
}

/** 셀 메모 기록/삭제 */
export async function setMemo(month: string, categoryId: string, memo: string | null): Promise<void> {
  const c = need()
  const row = await ensureMonthRow(month)
  const col = c.colOf.get(categoryId)
  if (col == null) return
  await gs.batchUpdate(c.id, [
    {
      updateCells: {
        range: { sheetId: c.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 },
        rows: [{ values: [{ note: memo ?? '' }] }],
        fields: 'note',
      },
    },
  ])
}

export async function addCategory(cat: Category): Promise<void> {
  const c = need()
  let j: number
  if (c.managed) {
    // 수입은 이월잔고 앞, 지출은 지출합계 앞 — 그룹 라벨과 수식은 뒤에서 다시 쓴다
    j = cat.kind === '수입' ? (c.carryCol >= 0 ? c.carryCol : c.headers.indexOf('지출합계')) : c.headers.indexOf('지출합계')
    if (j < 0) j = c.headers.length
  } else {
    const group = c.cats.filter((k) => k.kind === cat.kind).map((k) => c.colOf.get(k.id)!)
    if (cat.kind === '수입') {
      j = group.length ? Math.max(...group) : c.carryCol >= 0 ? c.carryCol : c.expenseStart
    } else {
      // '지출' 라벨 앞에 끼어들면 라벨이 밀려 수입으로 읽히므로 항상 라벨 뒤에
      const after = c.expenseStart + 1
      j = group.length ? Math.max(Math.max(...group), after) : Math.max(c.headers.length, after)
      if (!group.length)
        for (let cc = c.expenseStart; cc < c.headers.length; cc++)
          if (COMPUTED.includes(c.headers[cc])) {
            j = Math.max(cc, after)
            break
          }
    }
  }
  await gs.batchUpdate(c.id, [
    {
      insertDimension: {
        range: { sheetId: c.sheetId, dimension: 'COLUMNS', startIndex: j, endIndex: j + 1 },
        inheritFromBefore: j > 1,
      },
    },
  ])
  for (const [catId, col] of c.colOf) if (col >= j) c.colOf.set(catId, col + 1)
  if (c.carryCol >= j) c.carryCol++
  if (c.expenseStart >= j) c.expenseStart++
  c.headers.splice(j, 0, cat.name)
  c.colOf.set(cat.id, j)
  c.cats = [...c.cats, { ...cat, order: j }]
  await gs.batchSetValues(c.id, [{ range: `${LEDGER}!${a1(j)}3`, values: [[cat.name]] }], 'RAW')
  if (cat.excluded || cat.hidden) await writeHeaderNote(cat)
  if (c.managed) {
    await rewriteGroups()
    await rewriteManaged()
  }
}

export async function updateCategory(cat: Category): Promise<void> {
  const c = need()
  const col = c.colOf.get(cat.id)
  if (col == null) throw new Error('항목을 찾지 못했습니다.')
  const old = c.cats.find((k) => k.id === cat.id)
  c.cats = c.cats.map((k) => (k.id === cat.id ? { ...cat, order: col } : k))
  if (old?.name !== cat.name) {
    await gs.batchSetValues(c.id, [{ range: `${LEDGER}!${a1(col)}3`, values: [[cat.name]] }], 'RAW')
    c.headers[col] = cat.name
  }
  if (old?.excluded !== cat.excluded || old?.hidden !== cat.hidden) {
    await writeHeaderNote(cat)
    if (old?.excluded !== cat.excluded) await rewriteManaged()
  }
}

export async function deleteCategory(id: string): Promise<void> {
  const c = need()
  const col = c.colOf.get(id)
  if (col == null) return
  // '지출' 그룹 라벨(2행)이 이 열에 있으면 열과 함께 지워지므로 뒤에서 복원해야 한다
  const hadLabel = !c.managed && col === c.expenseStart
  await gs.batchUpdate(c.id, [
    { deleteDimension: { range: { sheetId: c.sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 } } },
  ])
  c.colOf.delete(id)
  for (const [catId, cc] of c.colOf) if (cc > col) c.colOf.set(catId, cc - 1)
  if (c.carryCol > col) c.carryCol--
  if (c.expenseStart > col) c.expenseStart--
  c.headers.splice(col, 1)
  c.cats = c.cats.filter((k) => k.id !== id)
  if (c.managed) {
    await rewriteGroups()
    await rewriteManaged()
    return
  }
  if (hadLabel) {
    const expCols = c.cats.filter((k) => k.kind === '지출').map((k) => c.colOf.get(k.id)!)
    let next = expCols.length ? Math.min(...expCols) : -1
    if (next < 0)
      for (let cc = col; cc < c.headers.length; cc++)
        if (COMPUTED.includes(c.headers[cc])) {
          next = cc
          break
        }
    if (next >= 0) {
      await gs.batchSetValues(c.id, [{ range: `${LEDGER}!${a1(next)}2`, values: [['지출']] }], 'RAW')
      c.expenseStart = next
    }
  }
}

/** 항목을 같은 구분의 다른 항목 위치로 이동 (드래그 정렬) */
export async function moveCategoryTo(id: string, targetId: string): Promise<void> {
  const c = need()
  const cat = c.cats.find((k) => k.id === id)
  const target = c.cats.find((k) => k.id === targetId)
  const col = c.colOf.get(id)
  const tcol = c.colOf.get(targetId)
  if (!cat || !target || col == null || tcol == null || cat.kind !== target.kind || col === tcol) return
  await gs.batchUpdate(c.id, [
    {
      moveDimension: {
        source: { sheetId: c.sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
        // destinationIndex는 이동 전 좌표 기준 — 오른쪽 이동은 대상 뒤, 왼쪽 이동은 대상 앞
        destinationIndex: col < tcol ? tcol + 1 : tcol,
      },
    },
  ])
  // 이동으로 밀린 열 인덱스들 반영 (이동한 열의 최종 위치는 tcol)
  const shift = (v: number) => (col < tcol ? (v > col && v <= tcol ? v - 1 : v) : (v >= tcol && v < col ? v + 1 : v))
  for (const [catId, v] of c.colOf) c.colOf.set(catId, catId === id ? tcol : shift(v))
  if (c.carryCol >= 0) c.carryCol = shift(c.carryCol)
  const [h] = c.headers.splice(col, 1)
  c.headers.splice(tcol, 0, h)
  c.expenseStart = c.expenseStart === col ? tcol : shift(c.expenseStart)
  if (c.managed) {
    await rewriteGroups()
    return
  }
  // '지출' 그룹 라벨(2행)은 자기 열과 함께 움직인다 — 그룹 맨 앞이 바뀌었으면 라벨을 맨 앞으로 되돌린다
  if (cat.kind === '지출') {
    const expMin = Math.min(...c.cats.filter((k) => k.kind === '지출').map((k) => c.colOf.get(k.id)!))
    if (expMin !== c.expenseStart && c.expenseStart < c.headers.length) {
      await gs.batchSetValues(
        c.id,
        [
          { range: `${LEDGER}!${a1(c.expenseStart)}2`, values: [['']] },
          { range: `${LEDGER}!${a1(expMin)}2`, values: [['지출']] },
        ],
        'RAW',
      )
      c.expenseStart = expMin
    }
  }
}

/** 예전 이중 구조(가계부앱_항목/기록)의 플래그·메모·누락값을 가계부 시트로 옮기고 탭 이름을 바꾼다 */
async function migrateAppSheets(id: string): Promise<void> {
  const c = need()
  const [catRes, entRes] = await Promise.all([
    gs.getValues(id, '가계부앱_항목!A2:F').catch(() => null),
    gs.getValues(id, '가계부앱_기록!A2:E').catch(() => null),
  ])
  const oldCats = ((catRes?.values ?? []) as unknown[][])
    .filter((r) => r[0])
    .map((r, i) => ({
      id: String(r[0]),
      kind: (r[1] === '수입' ? '수입' : '지출') as Kind,
      name: String(r[2] ?? ''),
      excluded: r[3] === 'Y',
      order: Number(r[4] ?? i),
      hidden: r[5] === 'Y',
    }))
  const oldEntries = ((entRes?.values ?? []) as unknown[][])
    .filter((r) => r[0] && r[1])
    .map((r) => ({
      month: String(r[0]),
      categoryId: String(r[1]),
      amount: Number(String(r[2] ?? 0).replace(/,/g, '')) || 0,
      memo: r[3] ? String(r[3]) : undefined,
      formula: r[4] ? String(r[4]) : undefined,
    }))

  const idMap = new Map<string, string>([[CARRYOVER_ID, CARRYOVER_ID]])
  for (const oc of oldCats.sort((a, b) => a.order - b.order)) {
    let cat = c.cats.find((k) => k.name === oc.name && k.kind === oc.kind && ![...idMap.values()].includes(k.id))
    if (!cat) {
      cat = { id: newId(), kind: oc.kind, name: oc.name, excluded: oc.excluded, hidden: oc.hidden, order: 0 }
      await addCategory(cat)
    } else if (cat.excluded !== oc.excluded || cat.hidden !== oc.hidden) {
      await updateCategory({ ...cat, excluded: oc.excluded, hidden: oc.hidden })
    }
    idMap.set(oc.id, cat.id)
  }
  // 가계부 시트에 없는 기록만 채운다 (시트 값이 우선)
  const { entries: cur } = await loadAll(id)
  const curKeys = new Set(cur.map((e) => `${e.month}|${e.categoryId}`))
  const fills = oldEntries
    .map((oe) => ({ ...oe, newId: idMap.get(oe.categoryId) }))
    .filter((oe) => oe.newId && !curKeys.has(`${oe.month}|${oe.newId}`))
    .map((oe) => ({ month: oe.month, categoryId: oe.newId!, amount: oe.amount, formula: oe.formula }))
  if (fills.length) await setAmounts(fills)
  for (const oe of oldEntries) {
    const nid = idMap.get(oe.categoryId)
    if (oe.memo && nid && nid !== CARRYOVER_ID) await setMemo(oe.month, nid, oe.memo)
  }
  const meta = await gs.meta(id)
  const renames = (meta.sheets as { properties: { title: string; sheetId: number } }[])
    .filter((s) => ['가계부앱_항목', '가계부앱_기록'].includes(s.properties.title))
    .map((s) => ({
      updateSheetProperties: {
        properties: { sheetId: s.properties.sheetId, title: `${s.properties.title}_이전` },
        fields: 'title',
      },
    }))
  if (renames.length) await gs.batchUpdate(id, renames)
}
