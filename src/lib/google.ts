const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const SCOPE =
  'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly'
const LS_TOKEN = 'hb.token'
/** 이 브라우저에서 한 번이라도 권한에 동의했는지 — 조용한 재로그인 시도 여부를 판단한다 */
const LS_CONSENT = 'hb.consent'

let accessToken: string | null = null
let clientIdInUse = ''
let refreshTimer: number | undefined

export function isSignedIn(): boolean {
  return !!accessToken
}

/** 예전에 이 브라우저에서 권한에 동의한 적이 있으면 true */
export function hasConsented(): boolean {
  return localStorage.getItem(LS_CONSENT) === '1'
}

/** 새로고침 시 localStorage에 저장된 토큰이 유효하면 복원한다 */
export function restoreToken(): boolean {
  const raw = localStorage.getItem(LS_TOKEN)
  if (!raw) return false
  try {
    const { t, exp, s } = JSON.parse(raw) as { t: string; exp: number; s?: string }
    // 권한 범위가 바뀐 예전 토큰은 폐기 (예: 드라이브 목록 권한 추가 전 토큰)
    if (t && s === SCOPE && exp - 60_000 > Date.now()) {
      accessToken = t
      scheduleRefresh(exp - Date.now())
      return true
    }
  } catch {
    /* 무시 */
  }
  localStorage.removeItem(LS_TOKEN)
  return false
}

function persistToken(token: string, expiresInSec: number): void {
  localStorage.setItem(
    LS_TOKEN,
    JSON.stringify({ t: token, exp: Date.now() + expiresInSec * 1000, s: SCOPE }),
  )
  localStorage.setItem(LS_CONSENT, '1')
  scheduleRefresh(expiresInSec * 1000)
}

/** 토큰 만료 2분 전에 조용히 새 토큰을 받아 사용 중 세션이 끊기지 않게 한다 */
function scheduleRefresh(msUntilExpiry: number): void {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(
    () => {
      if (clientIdInUse) void signIn(clientIdInUse, true).catch(() => {})
    },
    Math.max(msUntilExpiry - 120_000, 10_000),
  )
}

/** GIS 스크립트는 async로 로드되므로 앱 시작 직후에는 아직 없을 수 있다 */
function gisReady(timeoutMs = 10_000): Promise<any> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const g = (window as unknown as { google?: any }).google
      if (g?.accounts?.oauth2) resolve(g)
      else if (Date.now() - start > timeoutMs)
        reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'))
      else setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * 로그인. silent면 동의 창 없이 토큰만 다시 받아온다(구글 세션이 살아 있을 때만 성공).
 * 브라우저가 서드파티 쿠키를 막으면 실패하므로 호출부에서 폴백을 준비해야 한다.
 */
export async function signIn(clientId: string, silent = false): Promise<void> {
  clientIdInUse = clientId
  const g = await gisReady()
  return new Promise((resolve, reject) => {
    // 조용한 재로그인은 아무 콜백도 오지 않을 수 있어 시간 제한을 둔다 (없으면 화면이 멈춘다)
    const timer = silent
      ? window.setTimeout(() => reject(new Error('자동 로그인에 응답이 없습니다.')), 8_000)
      : undefined
    const finish = (fn: () => void) => {
      window.clearTimeout(timer)
      fn()
    }
    const tokenClient = g.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp: { access_token?: string; expires_in?: number; error?: string }) =>
        finish(() => {
          if (resp.error || !resp.access_token) reject(new Error(resp.error ?? '로그인에 실패했습니다.'))
          else {
            accessToken = resp.access_token
            persistToken(resp.access_token, Number(resp.expires_in ?? 3600))
            resolve()
          }
        }),
      error_callback: (err: { message?: string }) =>
        finish(() => reject(new Error(err?.message ?? '로그인 창이 닫혔습니다.'))),
    })
    tokenClient.requestAccessToken(silent ? { prompt: '' } : {})
  })
}

export function signOut(): void {
  const g = (window as unknown as { google?: any }).google
  if (accessToken && g?.accounts?.oauth2) g.accounts.oauth2.revoke(accessToken, () => {})
  accessToken = null
  window.clearTimeout(refreshTimer)
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_CONSENT)
}

async function call(method: string, url: string, body?: unknown, retried = false): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401 && !retried && clientIdInUse) {
    await signIn(clientIdInUse, true)
    return call(method, url, body, true)
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google API 오류 ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

export const gs = {
  create: (title: string) => call('POST', SHEETS, { properties: { title } }),
  meta: (id: string) => call('GET', `${SHEETS}/${id}?fields=properties.title,sheets.properties`),
  getValues: (id: string, range: string, render?: 'raw' | 'formula') =>
    call(
      'GET',
      `${SHEETS}/${id}/values/${encodeURIComponent(range)}` +
        (render === 'raw'
          ? '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING'
          : render === 'formula'
            ? '?valueRenderOption=FORMULA'
            : ''),
    ),
  setValues: (id: string, range: string, values: unknown[][]) =>
    call('PUT', `${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { range, values }),
  /** 여러 범위를 한 번에 기록. 기본 USER_ENTERED — 수식(=...)이 수식으로 저장된다 */
  batchSetValues: (id: string, data: { range: string; values: unknown[][] }[], input: 'USER_ENTERED' | 'RAW' = 'USER_ENTERED') =>
    call('POST', `${SHEETS}/${id}/values:batchUpdate`, { valueInputOption: input, data }),
  clearValues: (id: string, range: string) =>
    call('POST', `${SHEETS}/${id}/values/${encodeURIComponent(range)}:clear`, {}),
  /** 범위 내 셀 메모(note) 그리드 조회 */
  getNotes: (id: string, range: string) =>
    call(
      'GET',
      `${SHEETS}/${id}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent('sheets.data.rowData.values.note')}`,
    ),
  batchUpdate: (id: string, requests: unknown[]) => call('POST', `${SHEETS}/${id}:batchUpdate`, { requests }),
}

export interface DriveFile {
  id: string
  name: string
  modifiedTime?: string
  parents?: string[]
  /** 앱에서 채우는 폴더 경로 */
  path?: string
}

const DRIVE_LIST = 'https://www.googleapis.com/drive/v3/files?q='

export const drive = {
  listSpreadsheets: async (query = ''): Promise<{ files: DriveFile[] }> => {
    const base = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
    const tail =
      '&orderBy=' + encodeURIComponent('modifiedTime desc') + '&pageSize=30&fields=files(id,name,modifiedTime,parents)'
    const esc = query.trim().replace(/'/g, "\\'")
    if (!esc) return call('GET', DRIVE_LIST + encodeURIComponent(base) + tail)
    // 이름이 일치하는 폴더를 찾아 그 폴더 안의 시트도 검색 대상에 포함
    let parentClause = ''
    try {
      const folders = await call(
        'GET',
        DRIVE_LIST +
          encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and trashed=false and name contains '${esc}'`) +
          '&pageSize=10&fields=files(id)',
      )
      parentClause = ((folders.files ?? []) as { id: string }[]).map((f) => ` or '${f.id}' in parents`).join('')
    } catch {
      /* 폴더 검색이 실패해도 이름 검색은 계속 */
    }
    const q = `${base} and (name contains '${esc}'${parentClause})`
    return call('GET', DRIVE_LIST + encodeURIComponent(q) + tail)
  },
}

const folderCache = new Map<string, { name: string; parent?: string } | null>()

async function getFolderInfo(id: string): Promise<{ name: string; parent?: string } | null> {
  const cached = folderCache.get(id)
  if (cached !== undefined) return cached
  try {
    const f = await call('GET', `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,parents`)
    const info = { name: f.name as string, parent: f.parents?.[0] as string | undefined }
    folderCache.set(id, info)
    return info
  } catch {
    folderCache.set(id, null)
    return null
  }
}

/** 상위 폴더를 거슬러 올라가 '내 드라이브 / 폴더 / …' 형태의 경로를 만든다 */
export async function folderPath(parentId?: string): Promise<string> {
  const parts: string[] = []
  let cur = parentId
  for (let depth = 0; cur && depth < 6; depth++) {
    const info = await getFolderInfo(cur)
    if (!info) break
    parts.unshift(info.name)
    cur = info.parent
  }
  return parts.join(' / ')
}
