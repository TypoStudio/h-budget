import { useRef, useState } from 'react'
import { Eye, EyeOff, GripVertical, Trash2 } from 'lucide-react'
import type { Category, Entry, Kind } from '../types'
import AddCategoryForm from './AddCategoryForm'

interface Props {
  categories: Category[]
  entries: Entry[]
  onChange: (c: Category) => void
  onDelete: (id: string) => void
  /** 드래그 정렬: id 항목을 targetId 항목 위치로 이동 */
  onReorder: (id: string, targetId: string) => void
  onAdd: (kind: Kind, name: string, excluded: boolean) => void
}

function NameInput({ name, onCommit }: { name: string; onCommit: (n: string) => void }) {
  const [text, setText] = useState(name)
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim()
        if (t && t !== name) onCommit(t)
        else setText(name)
      }}
      onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
    />
  )
}

export default function CategoryManager({ categories, entries, onChange, onDelete, onReorder, onAdd }: Props) {
  const count = (id: string) => entries.filter((e) => e.categoryId === id).length

  // 포인터 기반 드래그 정렬 (마우스·터치 공통)
  const [drag, setDrag] = useState<{ id: string; kind: Kind; overId: string | null; x: number; y: number } | null>(
    null,
  )
  const rowRefs = useRef(new Map<string, HTMLElement>())

  const dragMove = (e: React.PointerEvent) => {
    if (!drag) return
    let overId: string | null = null
    for (const c of categories) {
      if (c.kind !== drag.kind) continue
      const r = rowRefs.current.get(c.id)?.getBoundingClientRect()
      if (r && e.clientY >= r.top && e.clientY < r.bottom) {
        overId = c.id
        break
      }
    }
    setDrag({ ...drag, overId, x: e.clientX, y: e.clientY })
  }
  const dragEnd = () => {
    if (drag?.overId && drag.overId !== drag.id) onReorder(drag.id, drag.overId)
    setDrag(null)
  }

  const section = (k: Kind) => {
    const cats = categories.filter((c) => c.kind === k).sort((a, b) => a.order - b.order)
    return (
      <section className={`card ${k === '수입' ? 'card-income' : 'card-expense'}`}>
        <h2>{k} 항목</h2>
        {cats.map((c) => (
          <div
            key={c.id}
            ref={(el) => {
              if (el) rowRefs.current.set(c.id, el)
              else rowRefs.current.delete(c.id)
            }}
            className={`cat-row ${c.hidden ? 'is-hidden' : ''} ${drag?.id === c.id ? 'dragging' : ''} ${
              drag && drag.overId === c.id && drag.id !== c.id ? 'drag-over' : ''
            }`}
          >
            <span
              className="drag-handle"
              title="끌어서 순서 변경"
              onPointerDown={(e) => {
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                setDrag({ id: c.id, kind: k, overId: null, x: e.clientX, y: e.clientY })
              }}
              onPointerMove={dragMove}
              onPointerUp={dragEnd}
              onPointerCancel={() => setDrag(null)}
            >
              <GripVertical size={16} />
            </span>
            <NameInput key={c.id + c.name} name={c.name} onCommit={(n) => onChange({ ...c, name: n })} />
            <div className="icons">
              <button
                className={`icon txt ${c.excluded ? 'toggled' : ''}`}
                title={c.excluded ? '합계에서 제외 중 — 누르면 합산에 포함' : '합산 중 — 누르면 합계에서 제외'}
                onClick={() => onChange({ ...c, excluded: !c.excluded })}
              >
                {c.excluded ? '제외' : '합산'}
              </button>
              <button
                className={`icon ${c.hidden ? 'toggled' : ''}`}
                title={c.hidden ? '숨김 중 — 누르면 표시' : '월별 뷰에서 숨김'}
                onClick={() => onChange({ ...c, hidden: !c.hidden })}
              >
                {c.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              {/* 삭제는 열을 통째로 지운다 — 기록이 있으면 과거 데이터까지 사라지므로 숨김으로 유도 */}
              <button
                className="icon danger"
                disabled={count(c.id) > 0}
                title={
                  count(c.id) > 0
                    ? `기록 ${count(c.id)}건이 있어 삭제할 수 없습니다 — 눈 버튼으로 숨기세요`
                    : '삭제'
                }
                onClick={() => {
                  if (window.confirm(`'${c.name}' 항목을 삭제할까요?`)) onDelete(c.id)
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
        {cats.length === 0 && <p className="hint">항목이 없습니다</p>}
        <AddCategoryForm kind={k} onAdd={onAdd} />
      </section>
    )
  }

  return (
    <div>
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          <GripVertical size={13} /> {categories.find((c) => c.id === drag.id)?.name}
        </div>
      )}
      <div className="sections">
        {section('수입')}
        {section('지출')}
      </div>
      <p className="hint">
        <GripVertical size={12} style={{ verticalAlign: -1 }} /> 핸들을 끌어 순서를 바꿀 수 있습니다. 합산/제외 버튼:
        '제외'로 바꾸면 표시는 되지만 합계·잔고 계산에서 빠집니다.{' '}
        <EyeOff size={12} style={{ verticalAlign: -1 }} /> 숨김: 월별 뷰에서 숨겨지며, 기록이 있는 달에는 표시됩니다.{' '}
        <Trash2 size={12} style={{ verticalAlign: -1 }} /> 삭제는 시트의 열을 통째로 지우므로, 기록이 있는 항목은 지울 수
        없습니다 — 쓰지 않는 항목은 숨김으로 두세요.
      </p>
    </div>
  )
}
