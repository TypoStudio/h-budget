import { useEffect, useRef, useState } from 'react'
import { ExternalLink, FileSpreadsheet, LogOut, RefreshCw, Search } from 'lucide-react'
import { drive, folderPath, hasConsented, restoreToken, signIn, signOut, type DriveFile } from './lib/google'
import {
  addCategory as sheetAddCategory,
  CARRYOVER_ID,
  createSpreadsheet,
  deleteCategory as sheetDeleteCategory,
  deleteMonth as sheetDeleteMonth,
  loadAll,
  moveCategoryTo as sheetMoveCategoryTo,
  newId,
  openSpreadsheet,
  parseSpreadsheetId,
  setAmounts,
  setMemo as sheetSetMemo,
  updateCategory as sheetUpdateCategory,
} from './lib/sheetStore'
import { currentMonth } from './lib/calc'
import type { Category, Entry, Kind } from './types'
import MonthView from './components/MonthView'
import CategoryManager from './components/CategoryManager'
import Logo from './components/Logo'

const CLIENT_ID = '19660777308-ppephgm14ahfh54anmp243h094pgao4v.apps.googleusercontent.com'
const LS_SHEET = 'hb.spreadsheetId'
const LS_THEME = 'hb.theme'

const THEMES = [
  { id: 'excel', label: '엑셀' },
  { id: 'classic', label: '파스텔' },
  { id: 'ledger', label: '장부' },
  { id: 'manuscript', label: '고서' },
] as const

type Tab = 'month' | 'cats' | 'settings'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export default function App() {
  const [signedIn, setSignedIn] = useState(false)
  const [booting, setBooting] = useState(true)
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null)
  const [sheetTitle, setSheetTitle] = useState('')
  const [sheetInput, setSheetInput] = useState('')
  const [sheetList, setSheetList] = useState<DriveFile[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [listQuery, setListQuery] = useState('')
  const [listVersion, setListVersion] = useState(0)
  const [categories, setCategories] = useState<Category[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<Tab>('month')
  const [month, setMonth] = useState(currentMonth())
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState(() => localStorage.getItem(LS_THEME) ?? 'excel')

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(LS_THEME, theme)
  }, [theme])

  // ── 시트 쓰기 ───────────────────────────────────────────────
  // 모든 쓰기는 순차 실행 — 겹치면 행/열 삽입이 중복될 수 있다
  const opQueue = useRef<Promise<void>>(Promise.resolve())
  const run = (op: () => Promise<void>) => {
    setSaveState('saving')
    opQueue.current = opQueue.current.then(async () => {
      try {
        await op()
        setSaveState('saved')
      } catch (e) {
        setSaveState('error')
        fail(e)
      }
    })
  }

  /** 구조가 바뀌는 조작(항목 추가/삭제/이동) 뒤에는 시트를 다시 읽어 화면과 맞춘다 */
  const reloadData = async () => {
    if (!spreadsheetId) return
    const d = await loadAll(spreadsheetId)
    setCategories(d.categories)
    setEntries(d.entries)
  }

  // ── 로그인/연결 ─────────────────────────────────────────────
  const connectTo = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await openSpreadsheet(id)
      setSpreadsheetId(id)
      setSheetTitle(res.title)
      setCategories(res.categories)
      setEntries(res.entries)
      setLoaded(true)
      localStorage.setItem(LS_SHEET, id)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const handleSignIn = async () => {
    setError(null)
    try {
      await signIn(CLIENT_ID)
      setSignedIn(true)
      const stored = localStorage.getItem(LS_SHEET)
      if (stored) await connectTo(stored)
    } catch (e) {
      fail(e)
    }
  }

  // 재방문 시 로그인 유지: 저장된 토큰이 살아 있으면 그대로, 만료됐어도
  // 예전에 동의한 브라우저면 동의 창 없이 토큰만 다시 받아온다
  useEffect(() => {
    const boot = async () => {
      let ok = restoreToken()
      if (!ok && hasConsented()) ok = await signIn(CLIENT_ID, true).then(() => true, () => false)
      if (ok) {
        setSignedIn(true)
        const stored = localStorage.getItem(LS_SHEET)
        if (stored) await connectTo(stored)
      }
      setBooting(false)
    }
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 시트 선택 화면에서 내 스프레드시트 목록 로드 (검색어는 디바운스)
  useEffect(() => {
    if (!signedIn || loaded) return
    let cancelled = false
    setSheetList(null)
    setListError(null)
    const t = window.setTimeout(
      () => {
        drive
          .listSpreadsheets(listQuery)
          .then(async (r) => {
            const files = r.files ?? []
            const paths = await Promise.all(files.map((f) => folderPath(f.parents?.[0]).catch(() => '')))
            if (!cancelled) setSheetList(files.map((f, i) => ({ ...f, path: paths[i] })))
          })
          .catch((e) => {
            if (cancelled) return
            setSheetList([])
            setListError(
              e instanceof Error && e.message.includes('403')
                ? 'Google Drive API가 사용 설정되지 않았거나 권한이 없어 목록을 불러올 수 없습니다. URL 붙여넣기는 계속 사용할 수 있습니다.'
                : '스프레드시트 목록을 불러오지 못했습니다. URL 붙여넣기를 이용해주세요.',
            )
          })
      },
      listQuery ? 400 : 0,
    )
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [signedIn, loaded, listQuery, listVersion])

  const handleCreate = async () => {
    setBusy(true)
    setError(null)
    try {
      const id = await createSpreadsheet()
      await connectTo(id)
    } catch (e) {
      fail(e)
      setBusy(false)
    }
  }

  const disconnect = () => {
    localStorage.removeItem(LS_SHEET)
    setSpreadsheetId(null)
    setLoaded(false)
    setSheetList(null)
    setListError(null)
    setCategories([])
    setEntries([])
    setTab('month')
  }

  // ── 데이터 조작 (화면 먼저 반영, 시트 쓰기는 큐에서 순차 실행) ──
  const setAmount = (m: string, categoryId: string, amount: number | null, formula?: string) => {
    const existing = entries.find((e) => e.month === m && e.categoryId === categoryId)
    const rest = entries.filter((e) => !(e.month === m && e.categoryId === categoryId))
    setEntries(amount == null ? rest : [...rest, { month: m, categoryId, amount, memo: existing?.memo, formula }])
    run(() => setAmounts([{ month: m, categoryId, amount, formula }]))
  }

  const setMemo = (m: string, categoryId: string, memo: string | null) => {
    const existing = entries.find((e) => e.month === m && e.categoryId === categoryId)
    if (existing) {
      setEntries(entries.map((e) => (e === existing ? { ...e, memo: memo ?? undefined } : e)))
      run(() => sheetSetMemo(m, categoryId, memo))
    } else if (memo) {
      // 금액 없이 메모만 작성하면 0원 기록으로 저장
      setEntries([...entries, { month: m, categoryId, amount: 0, memo }])
      run(async () => {
        await setAmounts([{ month: m, categoryId, amount: 0 }])
        await sheetSetMemo(m, categoryId, memo)
      })
    }
  }

  /** from 월의 기록(이월 제외)을 to 월로 복제. to 월에 이미 값이 있는 항목은 건너뜀 */
  const copyMonth = (from: string, to: string) => {
    const existing = new Set(entries.filter((e) => e.month === to).map((e) => e.categoryId))
    const copied = entries
      .filter((e) => e.month === from && e.categoryId !== CARRYOVER_ID && !existing.has(e.categoryId))
      .map((e) => ({ month: to, categoryId: e.categoryId, amount: e.amount, formula: e.formula }))
    if (!copied.length) return
    setEntries([...entries, ...copied])
    run(() => setAmounts(copied))
  }

  /** 그 달 기록을 통째로 삭제 — 시트에서도 해당 월 행이 사라진다 */
  const deleteMonth = (m: string) => {
    setEntries(entries.filter((e) => e.month !== m))
    run(async () => {
      await sheetDeleteMonth(m)
      await reloadData()
    })
  }

  const addCategory = (kind: Kind, name: string, excluded: boolean) => {
    const order = categories.length ? Math.max(...categories.map((c) => c.order)) + 1 : 0
    const cat: Category = { id: newId(), kind, name, excluded, hidden: false, order }
    setCategories([...categories, cat])
    run(async () => {
      await sheetAddCategory(cat)
      await reloadData()
    })
  }

  const updateCategory = (cat: Category) => {
    setCategories(categories.map((c) => (c.id === cat.id ? cat : c)))
    run(() => sheetUpdateCategory(cat))
  }

  const deleteCategory = (id: string) => {
    setCategories(categories.filter((c) => c.id !== id))
    setEntries(entries.filter((e) => e.categoryId !== id))
    run(async () => {
      await sheetDeleteCategory(id)
      await reloadData()
    })
  }

  /** 드래그 정렬: id 항목을 targetId 항목 위치로 (사이 항목들은 한 칸씩 밀림) */
  const reorderCategory = (id: string, targetId: string) => {
    const cat = categories.find((c) => c.id === id)
    const target = categories.find((c) => c.id === targetId)
    if (!cat || !target || cat.kind !== target.kind || id === targetId) return
    const a = cat.order
    const b = target.order
    setCategories(
      categories.map((c) => {
        if (c.id === id) return { ...c, order: b }
        if (a < b && c.order > a && c.order <= b) return { ...c, order: c.order - 1 }
        if (a > b && c.order >= b && c.order < a) return { ...c, order: c.order + 1 }
        return c
      }),
    )
    run(async () => {
      await sheetMoveCategoryTo(id, targetId)
      await reloadData()
    })
  }

  // ── 화면 ────────────────────────────────────────────────────
  const errorBanner = error && (
    <div className="error">
      {error} <button className="link" onClick={() => setError(null)}>닫기</button>
    </div>
  )

  if (booting)
    return (
      <div className="center card">
        <p className="hint">로그인 확인 중…</p>
      </div>
    )

  if (!signedIn)
    return (
      <div className="center card">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Logo size={30} /> 가계부
        </h1>
        <p>구글 계정으로 로그인하면 내 스프레드시트에 가계부를 기록합니다.</p>
        <button className="primary" onClick={() => void handleSignIn()}>
          Google 로그인
        </button>
        {errorBanner}
      </div>
    )

  if (!spreadsheetId || !loaded)
    return (
      <div className="center card">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Logo size={30} /> 스프레드시트 연결
        </h1>
        <p>가계부를 저장할 구글 스프레드시트를 선택하세요.</p>

        <div className="list-head">
          <FileSpreadsheet size={14} /> 내 드라이브의 스프레드시트
          <button className="icon" title="목록 새로고침" onClick={() => setListVersion((v) => v + 1)}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="search-box">
          <Search size={14} />
          <input
            value={listQuery}
            placeholder="시트 이름으로 검색"
            onChange={(e) => setListQuery(e.target.value)}
          />
        </div>
        {sheetList === null && <p className="hint">목록 불러오는 중…</p>}
        {listError && (
          <div className="hint">
            {listError}
            <button
              className="link"
              onClick={() => {
                void signIn(CLIENT_ID)
                  .then(() => setListVersion((v) => v + 1))
                  .catch(fail)
              }}
            >
              권한 다시 요청
            </button>
          </div>
        )}
        {sheetList && sheetList.length === 0 && !listError && (
          <p className="hint">{listQuery ? '검색 결과가 없습니다.' : '드라이브에 스프레드시트가 없습니다.'}</p>
        )}
        {sheetList && sheetList.length > 0 && (
          <div className="sheet-list">
            {sheetList.map((f) => (
              <button key={f.id} disabled={busy} onClick={() => void connectTo(f.id)}>
                <FileSpreadsheet size={15} style={{ flexShrink: 0 }} />
                <span className="file-info">
                  <span className="name">{f.name}</span>
                  {f.path && <span className="path">{f.path}</span>}
                </span>
                {f.modifiedTime && <span className="date">{f.modifiedTime.slice(0, 10)}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="add-form">
          <input
            value={sheetInput}
            placeholder="스프레드시트 URL 또는 ID 붙여넣기"
            onChange={(e) => setSheetInput(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              const id = parseSpreadsheetId(sheetInput)
              if (!id) setError('스프레드시트 URL 또는 ID를 인식하지 못했습니다.')
              else void connectTo(id)
            }}
          >
            연결
          </button>
        </div>
        <div className="divider">또는</div>
        <button disabled={busy} onClick={() => void handleCreate()}>
          새 스프레드시트 만들기
        </button>
        {busy && <p className="hint">연결 중…</p>}
        {errorBanner}
      </div>
    )

  return (
    <div className="app">
      <header>
        <span className="title">
          <Logo /> 가계부
        </span>
        <nav>
          <button className={tab === 'month' ? 'active' : ''} onClick={() => setTab('month')}>
            월별
          </button>
          <button className={tab === 'cats' ? 'active' : ''} onClick={() => setTab('cats')}>
            항목 관리
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            설정
          </button>
        </nav>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {saveState !== 'idle' && (
            <span className={`save-state ${saveState}`}>
              {saveState === 'saving' && '저장 중…'}
              {saveState === 'saved' && '✓ 저장됨'}
              {saveState === 'error' && '저장 오류'}
            </span>
          )}
        </span>
      </header>
      {errorBanner}

      {tab === 'month' && (
        <MonthView
          categories={categories}
          entries={entries}
          month={month}
          onMonthChange={setMonth}
          onSetAmount={setAmount}
          onSetMemo={setMemo}
          onAddCategory={addCategory}
          onCopyMonth={copyMonth}
          onDeleteMonth={deleteMonth}
        />
      )}

      {tab === 'cats' && (
        <CategoryManager
          categories={categories}
          entries={entries}
          onChange={updateCategory}
          onDelete={deleteCategory}
          onReorder={reorderCategory}
          onAdd={addCategory}
        />
      )}

      {tab === 'settings' && (
        <div className="card">
          <h2>설정</h2>
          <p className="mb-2">
            테마:{' '}
            <select className="theme-select" value={theme} onChange={(e) => setTheme(e.target.value)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} 테마
                </option>
              ))}
            </select>
          </p>
          <p className="mb-2">
            연결된 시트: <b>{sheetTitle}</b>
          </p>
          <div className="btn-col">
            <button
              onClick={() => window.open(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`, '_blank')}
            >
              <ExternalLink size={15} /> 구글시트에서 열기
            </button>
            <button disabled={busy} onClick={() => spreadsheetId && void connectTo(spreadsheetId)}>
              <RefreshCw size={15} /> 시트에서 지금 다시 불러오기
            </button>
            <button onClick={disconnect}>
              <RefreshCw size={15} /> 다른 스프레드시트 연결
            </button>
            <button
              onClick={() => {
                signOut()
                setSignedIn(false)
                disconnect()
              }}
            >
              <LogOut size={15} /> 로그아웃
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
