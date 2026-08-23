import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { Kind } from '../types'

export default function AddCategoryForm({
  kind,
  onAdd,
}: {
  kind: Kind
  onAdd: (kind: Kind, name: string, excluded: boolean) => void
}) {
  const [name, setName] = useState('')
  const [excluded, setExcluded] = useState(false)
  const submit = () => {
    const n = name.trim()
    if (!n) return
    onAdd(kind, n, excluded)
    setName('')
    setExcluded(false)
  }
  return (
    <div className="add-form">
      <input
        value={name}
        placeholder={`새 ${kind} 항목 이름`}
        onChange={(e) => setName(e.target.value)}
        // 한글 조합 중 Enter는 조합을 확정하는 키다 — 여기서 추가하면 확정된 마지막 글자가 또 항목이 된다
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
      />
      <label className="chk">
        <input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} /> 합산제외
      </label>
      <button onClick={submit}>
        <Plus size={15} /> 추가
      </button>
    </div>
  )
}
