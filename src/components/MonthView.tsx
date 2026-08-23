import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleSlash2, Copy, Eye, EyeOff, Plus, Printer, StickyNote, Trash2 } from 'lucide-react'
import type { Category, Entry, Kind } from '../types'
import { computeAllMonths, fmt, shiftMonth, statsFor } from '../lib/calc'
import { CARRYOVER_ID } from '../lib/sheetStore'
import AddCategoryForm from './AddCategoryForm'
import AmountInput from './AmountInput'
import MonthReport from './MonthReport'

interface Props {
  categories: Category[]
  entries: Entry[]
  month: string
  onMonthChange: (m: string) => void
  onSetAmount: (month: string, categoryId: string, amount: number | null, formula?: string) => void
  onSetMemo: (month: string, categoryId: string, memo: string | null) => void
  onAddCategory: (kind: Kind, name: string, excluded: boolean) => void
  onCopyMonth: (from: string, to: string) => void
  onDeleteMonth: (month: string) => void
}

export default function MonthView({
  categories,
  entries,
  month,
  onMonthChange,
  onSetAmount,
  onSetMemo,
  onAddCategory,
  onCopyMonth,
  onDeleteMonth,
}: Props) {
  const all = useMemo(() => computeAllMonths(categories, entries), [categories, entries])
  const stats = statsFor(all, month)
  const [memoEdit, setMemoEdit] = useState<string | null>(null)
  const [showReport, setShowReport] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [showHidden, setShowHidden] = useState<Record<Kind, boolean>>({ 수입: false, 지출: false })
  const [addOpen, setAddOpen] = useState<Record<Kind, boolean>>({ 수입: false, 지출: false })

  useEffect(() => {
    setMemoEdit(null)
    setCopyOpen(false)
    setShowHidden({ 수입: false, 지출: false })
    setAddOpen({ 수입: false, 지출: false })
  }, [month])

  const entryMap = useMemo(() => {
    const m = new Map<string, Entry>()
    for (const e of entries) if (e.month === month) m.set(e.categoryId, e)
    return m
  }, [entries, month])

  // 복제 대상으로 고를 수 있는 월: 이월 외 기록이 있는 다른 월 (최신순)
  const copyableMonths = useMemo(
    () =>
      [...new Set(entries.filter((e) => e.categoryId !== CARRYOVER_ID).map((e) => e.month))]
        .filter((mm) => mm !== month)
        .sort()
        .reverse(),
    [entries, month],
  )

  const section = (kind: Kind) => {
    // 숨김 항목은 해당 월에 기록이 있을 때만 표시 (토글로 일시 표시 가능)
    const cats = categories
      .filter((c) => c.kind === kind && (!c.hidden || entryMap.has(c.id) || showHidden[kind]))
      .sort((a, b) => a.order - b.order)
    const hasHidden = categories.some((c) => c.kind === kind && c.hidden)
    const total = kind === '수입' ? stats.income : stats.expense
    return (
      <section className={`card ${kind === '수입' ? 'card-income' : 'card-expense'}`}>
        <h2>
          {kind}
          <span className="head-btns">
            {hasHidden && (
              <button
                className={`icon ${showHidden[kind] ? 'toggled' : ''}`}
                title={showHidden[kind] ? '숨김 항목 감추기' : '숨김 항목 표시 — 이번 달에 일시적으로 입력'}
                onClick={() => setShowHidden({ ...showHidden, [kind]: !showHidden[kind] })}
              >
                {showHidden[kind] ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            )}
            <button
              className={`icon ${addOpen[kind] ? 'toggled' : ''}`}
              title={addOpen[kind] ? '새 항목 추가 닫기' : '새 항목 추가'}
              onClick={() => setAddOpen({ ...addOpen, [kind]: !addOpen[kind] })}
            >
              <Plus size={17} />
            </button>
          </span>
        </h2>
        <table>
          <tbody>
            {cats.map((c) => {
              const entry = entryMap.get(c.id)
              return (
                <Fragment key={c.id}>
                  <tr className={c.excluded ? 'excluded' : ''}>
                    <td>
                      <div className="cat-label">
                        <span className="cat-name">{c.name}</span>
                        {c.excluded && (
                          <span className="badge-icon" title="합산제외 — 합계에 포함되지 않음">
                            <CircleSlash2 size={12} />
                          </span>
                        )}
                        {c.hidden && <span className="badge">숨김</span>}
                        <button
                          className={`icon memo-btn ${entry?.memo ? 'toggled' : ''}`}
                          title={entry?.memo ? '메모 수정' : '메모 추가'}
                          onClick={() => setMemoEdit(memoEdit === c.id ? null : c.id)}
                        >
                          <StickyNote size={13} />
                        </button>
                      </div>
                      {entry?.memo && memoEdit !== c.id && <div className="memo-text">{entry.memo}</div>}
                    </td>
                    <td className="num">
                      <AmountInput
                        value={entry?.amount ?? null}
                        formula={entry?.formula}
                        onCommit={(n, f) => onSetAmount(month, c.id, n, f)}
                      />
                    </td>
                  </tr>
                  {memoEdit === c.id && (
                    <tr className="memo-row">
                      <td colSpan={2}>
                        <input
                          autoFocus
                          defaultValue={entry?.memo ?? ''}
                          placeholder="메모 입력 — Enter로 저장, 비우면 삭제"
                          onBlur={(e) => {
                            onSetMemo(month, c.id, e.target.value.trim() || null)
                            setMemoEdit(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                            if (e.key === 'Escape') setMemoEdit(null)
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {cats.length === 0 && (
              <tr>
                <td className="empty" colSpan={2}>
                  타이틀의 + 버튼으로 항목을 추가하세요
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>{kind}합계</td>
              <td className="num total">
                <input className="amount" readOnly tabIndex={-1} value={fmt(total)} />
              </td>
            </tr>
          </tfoot>
        </table>
        {addOpen[kind] && <AddCategoryForm kind={kind} onAdd={onAddCategory} />}
      </section>
    )
  }

  if (showReport)
    return (
      <MonthReport
        categories={categories}
        entries={entries}
        month={month}
        stats={stats}
        onClose={() => setShowReport(false)}
      />
    )

  return (
    <div>
      <div className="month-nav">
        <button className="icon" title="이전 달" onClick={() => onMonthChange(shiftMonth(month, -1))}>
          <ChevronLeft size={18} />
        </button>
        <input type="month" value={month} onChange={(e) => e.target.value && onMonthChange(e.target.value)} />
        <button className="icon" title="다음 달" onClick={() => onMonthChange(shiftMonth(month, 1))}>
          <ChevronRight size={18} />
        </button>
        {copyableMonths.length > 0 && (
          <span className="copy-wrap">
            <button
              title="선택한 달의 기록을 이번 달로 복제 (이미 값이 있는 항목과 이월잔고는 제외)"
              onClick={() => setCopyOpen(!copyOpen)}
            >
              <Copy size={15} />
            </button>
            {copyOpen && (
              <>
                <div className="popup-backdrop" onClick={() => setCopyOpen(false)} />
                <div className="popup">
                  <div className="popup-title">가져올 달 선택</div>
                  {copyableMonths.map((mm) => {
                    const [yy, mo] = mm.split('-')
                    return (
                      <button
                        key={mm}
                        onClick={() => {
                          onCopyMonth(mm, month)
                          setCopyOpen(false)
                        }}
                      >
                        {yy}년 {Number(mo)}월
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </span>
        )}
        <button style={{ marginLeft: 'auto' }} title="인쇄/캡처용 보기" onClick={() => setShowReport(true)}>
          <Printer size={15} />
        </button>
        {entryMap.size > 0 && (
          <button
            title="이 달 기록 전체 삭제 — 시트에서 이 달 행이 통째로 사라집니다"
            onClick={() => {
              const [y, mo] = month.split('-')
              if (
                confirm(
                  `${y}년 ${Number(mo)}월 기록 ${entryMap.size}건을 모두 삭제할까요?\n시트에서 이 달 행이 통째로 사라집니다.`,
                )
              )
                onDeleteMonth(month)
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="summary">
        <div className="stat">
          <div className="label">
            이월잔고
            {stats.carryOverridden && (
              <button className="link" onClick={() => onSetAmount(month, CARRYOVER_ID, null)}>
                자동으로
              </button>
            )}
          </div>
          <AmountInput
            value={stats.carryOverridden ? stats.carry : null}
            formula={entryMap.get(CARRYOVER_ID)?.formula}
            placeholder={fmt(stats.carry)}
            onCommit={(n, f) => onSetAmount(month, CARRYOVER_ID, n, f)}
          />
        </div>
        <div className="stat">
          <div className="label">수입합계</div>
          <div className="value plus">{fmt(stats.income)}</div>
        </div>
        <div className="stat">
          <div className="label">지출합계</div>
          <div className="value minus">{fmt(stats.expense)}</div>
        </div>
        <div className="stat">
          <div className="label">잔고</div>
          <div className={`value ${stats.balance < 0 ? 'minus' : ''}`}>{fmt(stats.balance)}</div>
        </div>
      </div>

      <div className="sections">
        {section('수입')}
        {section('지출')}
      </div>
    </div>
  )
}
