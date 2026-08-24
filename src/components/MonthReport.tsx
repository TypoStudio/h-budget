import { useRef, useState } from 'react'
import { Image, Printer, X } from 'lucide-react'
import { toBlob } from 'html-to-image'
import type { Category, Entry, Kind, MonthStats } from '../types'
import { fmt } from '../lib/calc'

interface Props {
  categories: Category[]
  entries: Entry[]
  month: string
  stats: MonthStats
  onClose: () => void
}

interface Row {
  c: Category
  e: Entry
}

/** 원본 '당월' 시트처럼 인쇄/캡처용으로 깔끔하게 정리한 당월 요약 */
export default function MonthReport({ categories, entries, month, stats, onClose }: Props) {
  const [y, m] = month.split('-')
  const reportRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)

  /**
   * 리포트를 PNG로 만들어 페이지 안 팝업에 띄운다.
   * 곧바로 내려받으면 모바일에서 사진첩이 아니라 파일 앱으로 들어가므로,
   * 이미지를 띄워 두고 길게 누르거나(모바일) 우클릭해서(데스크톱) 직접 저장하게 한다.
   */
  const saveImage = async () => {
    const node = reportRef.current
    if (!node) return
    setSaving(true)
    try {
      // skipFonts: 시스템 폰트만 쓰므로 폰트 임베드(외부 fetch) 단계를 건너뛴다.
      // 폭·높이를 넘겨야 가운데 정렬(margin auto) 때문에 옆이 잘리지 않는다
      const blob = await toBlob(node, {
        pixelRatio: 2,
        skipFonts: true,
        width: node.scrollWidth,
        height: node.scrollHeight,
        style: { margin: '0' },
        backgroundColor: getComputedStyle(node).backgroundColor,
      })
      if (!blob) throw new Error('이미지를 만들지 못했습니다.')
      setPreview(URL.createObjectURL(blob))
    } catch {
      alert('이미지를 만들지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null)
  }

  const entryOf = new Map(entries.filter((e) => e.month === month).map((e) => [e.categoryId, e]))

  const rows = (kind: Kind, excluded: boolean): Row[] =>
    categories
      .filter((c) => c.kind === kind && c.excluded === excluded && entryOf.has(c.id))
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ c, e: entryOf.get(c.id)! }))

  const refRows = [...rows('수입', true), ...rows('지출', true)]

  const table = (title: string, list: Row[], total?: number, cls = '') => (
    <table className={`report-table ${cls}`}>
      <thead>
        <tr>
          <th colSpan={3}>{title}</th>
        </tr>
      </thead>
      <tbody>
        {list.map(({ c, e }) => (
          <tr key={c.id}>
            <td className="name">{c.name}</td>
            <td className="memo">{e.memo ?? ''}</td>
            <td className="num">{fmt(e.amount)}</td>
          </tr>
        ))}
        {list.length === 0 && (
          <tr>
            <td colSpan={3} className="empty">
              기록 없음
            </td>
          </tr>
        )}
      </tbody>
      {total !== undefined && (
        <tfoot>
          <tr>
            <td colSpan={2}>{title}합계</td>
            <td className="num">{fmt(total)}</td>
          </tr>
        </tfoot>
      )}
    </table>
  )

  return (
    <div>
      <div className="no-print" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 12 }}>
        <button disabled={saving} onClick={() => void saveImage()}>
          <Image size={15} /> {saving ? '저장 중…' : '이미지로 저장'}
        </button>
        <button onClick={() => window.print()}>
          <Printer size={15} /> 인쇄
        </button>
        <button onClick={onClose}>
          <X size={15} /> 닫기
        </button>
      </div>

      <div className="report" ref={reportRef}>
        <h1 className="report-title">
          {y}년 {Number(m)}월 가계부
        </h1>

        {table('수입', rows('수입', false), stats.income, 'report-income')}
        {table('지출', rows('지출', false), stats.expense, 'report-expense')}

        <table className="report-table report-summary">
          <tbody>
            <tr>
              <td>이월잔고</td>
              <td className="num">{fmt(stats.carry)}</td>
            </tr>
            <tr>
              <td>수입합계</td>
              <td className="num">{fmt(stats.income)}</td>
            </tr>
            <tr>
              <td>지출합계</td>
              <td className="num">{fmt(stats.expense)}</td>
            </tr>
            <tr className="balance">
              <td>잔고</td>
              <td className="num">{fmt(stats.balance)}</td>
            </tr>
          </tbody>
        </table>

        {refRows.length > 0 && table('참고 (합산 제외)', refRows)}

        <p className="report-footer">
          © {new Date().getFullYear()} 가계부 · {location.host}
        </p>
      </div>

      {preview && (
        <div className="img-modal no-print" onClick={closePreview}>
          <div className="img-modal-box" onClick={(e) => e.stopPropagation()}>
            <img src={preview} alt={`가계부 ${y}년 ${Number(m)}월`} />
            <p className="hint">이미지를 길게 누르거나 오른쪽 클릭해 저장하세요.</p>
            <button onClick={closePreview}>
              <X size={15} /> 닫기
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
