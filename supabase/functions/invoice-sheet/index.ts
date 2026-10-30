import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SPREADSHEET_ID = '1fxzGdAE64wcFLL0_mZI-eFk6U5jxqCh7DtAIzinoymQ';
const RATE_SHEET_ID = 101300522;
const ROSTER_SHEET_ID = '1yVKQLSmdc9RZ2U5m4CIPqAl4JqP9siiSeSRP0z3SEEM';
const ROSTER_SHEET_NAME = '人員名簿';
const SPECIAL_SHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const SPECIAL_SHEET_NAME = 'フォームの回答 1';
// 特別日当の DBキャッシュ (sm_kv_cache)。 単価マスタと同じ方式。
// isolate内キャッシュだと新しい isolate が毎回 Sheets を叩いてしまい、
// 「1分あたりの読取上限(429)」を解消できなかったため、全 isolate 共有のDBに置く。
// 追加/更新/削除時は破棄して、保存直後の再取得が古い値を返さないようにする。
// ── 人員名簿の電話を中央人材マスタ(staff_master)で補完する ────────────────────
// 人員名簿シートの D列 が空でも、NexPort/中央マスタ側に電話があるケースが常態化していた。
// シートを唯一の情報源にすると、登録タイミング次第で「電話未登録」となり確定保存や
// ビューア照合が落ちる。読み取り時に補完して、参照側の実装を1本化する。
const rosterNameKey = (s: unknown) => String(s ?? '').replace(/[\s　 ]+/g, '').trim();
// 名簿 D列の電話を国内表記に直す。数値セルで先頭の0が落ちた番号(9046064175)や +81 形式が
// そのまま支払明細の確定に入り、明細ビューア・支払通知の本人照合が外れた(2026-09分 7名)。
const fixJpPhone = (v: unknown): string => {
  const raw = String(v ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  let d = raw.replace(/[^0-9]/g, '');
  if (!d) return raw.trim();
  if (d.startsWith('81') && (d.length === 11 || d.length === 12)) d = '0' + d.slice(2);
  else if (!d.startsWith('0') && (d.length === 9 || d.length === 10)) d = '0' + d;
  return d;
};
// 戻り値: {filled, ambiguous, map}
//   map = 氏名キー -> 電話 (同姓同名で割れていないものだけ)。
//   名簿シートに行が無い人は補完しようがないため、参照側が直接引けるよう map も返す。
// 同姓同名(例: 佐々田伸吾・庄司正志)が別の電話を持つケースが実在するため、
// 先勝ちで入れると「別人の電話で明細が引ける」事故になる。割れている名前は補完しない。
async function fillRosterPhones(rows: any[][]): Promise<{ filled: string[]; ambiguous: string[]; map: Record<string,string> }> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const empty = { filled: [] as string[], ambiguous: [] as string[], map: {} as Record<string,string> };
  if (!SB_URL || !SRK || !Array.isArray(rows) || !rows.length) return empty;
  let master: any[] = [];
  try {
    const r = await fetch(`${SB_URL}/rest/v1/staff_master?select=full_name,phone&phone=not.is.null`,
      { headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } });
    if (r.ok) master = await r.json();
  } catch (_) { return empty; } // 補完できなくても名簿自体は返す(従来動作)
  if (!Array.isArray(master) || !master.length) return empty;
  const byName = new Map<string, Set<string>>();
  for (const m of master) {
    const k = rosterNameKey(m?.full_name);
    const p = String(m?.phone ?? '').trim();
    if (!k || !p) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k)!.add(p);
  }
  // 名簿シートに行が無い人(上田雪枝が該当した)は補完先が無いので、参照側が直接引ける map を返す
  const map: Record<string,string> = {};
  for (const [k, set] of byName) if (set.size === 1) map[k] = [...set][0];
  const filled: string[] = [], ambiguous: string[] = [];
  for (const r of rows) {
    const k = rosterNameKey(r?.[2]);
    if (!k || String(r?.[3] ?? '').trim()) continue;
    const set = byName.get(k);
    if (!set || !set.size) continue;
    const name = String(r[2]).trim();
    if (set.size > 1) { ambiguous.push(name); continue; } // 同姓同名で割れている → 触らない
    while (r.length < 4) r.push('');
    r[3] = [...set][0];
    filled.push(name);
  }
  return { filled, ambiguous, map };
}

const SPECIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5分
async function getSpecialRowsCached(): Promise<any[][]> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  let cached: any = null;
  if (SB_URL && SRK) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/sm_kv_cache?select=data,updated_at&key=eq.special_rates`, { headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } });
      if (r.ok) { const a = await r.json(); cached = Array.isArray(a) && a[0] ? a[0] : null; }
    } catch (_) { /* noop */ }
  }
  if (cached && cached.updated_at && Array.isArray(cached.data)
    && (Date.now() - new Date(cached.updated_at).getTime() < SPECIAL_CACHE_TTL_MS)) return cached.data as any[][];
  try {
    const rows = await fetchSheetValuesWithRetry(`${SPECIAL_SHEET_NAME}!A2:K5000`, getAccessToken, 3, SPECIAL_SHEET_ID); // K=変更日
    if (SB_URL && SRK) {
      try {
        await fetch(`${SB_URL}/rest/v1/sm_kv_cache`, {
          method: 'POST',
          headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ key: 'special_rates', data: rows, updated_at: new Date().toISOString() }]),
        });
      } catch (_) { /* キャッシュ更新失敗は無視 */ }
    }
    return rows;
  } catch (e) {
    if (cached && Array.isArray(cached.data)) return cached.data as any[][]; // 期限切れでもキャッシュで凌ぐ
    throw e;
  }
}
// 稼働記録の DBキャッシュ。 ログイン時と一覧表示で毎回 A2:J5000 を読んでおり、
// Sheets の「1分あたり読取上限(429)」を大きく食っていた。
// ★ 書き込み前の重複チェック/行番号特定はキャッシュを使わない (実データが必要)。
//   ここは表示専用の経路 (ログイン時の先読み・list_work) だけで使う。
const WORK_CACHE_TTL_MS = 2 * 60 * 1000; // 2分 (稼働登録は随時入るので短め)
async function getWorkRowsCached(): Promise<any[][]> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  let cached: any = null;
  if (SB_URL && SRK) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/sm_kv_cache?select=data,updated_at&key=eq.work_rows`, { headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } });
      if (r.ok) { const a = await r.json(); cached = Array.isArray(a) && a[0] ? a[0] : null; }
    } catch (_) { /* noop */ }
  }
  if (cached && cached.updated_at && Array.isArray(cached.data)
    && (Date.now() - new Date(cached.updated_at).getTime() < WORK_CACHE_TTL_MS)) return cached.data as any[][];
  try {
    const rows = await fetchSheetValuesWithRetry('稼働記録!A2:J5000', getAccessToken);
    if (SB_URL && SRK) {
      try {
        await fetch(`${SB_URL}/rest/v1/sm_kv_cache`, {
          method: 'POST',
          headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ key: 'work_rows', data: rows, updated_at: new Date().toISOString() }]),
        });
      } catch (_) { /* noop */ }
    }
    return rows;
  } catch (e) {
    if (cached && Array.isArray(cached.data)) return cached.data as any[][];
    throw e;
  }
}
async function invalidateWorkCache(): Promise<void> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SB_URL || !SRK) return;
  try { await fetch(`${SB_URL}/rest/v1/sm_kv_cache?key=eq.work_rows`, { method: 'DELETE', headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } }); } catch (_) { /* noop */ }
}
async function invalidateSpecialCache(): Promise<void> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SB_URL || !SRK) return;
  try { await fetch(`${SB_URL}/rest/v1/sm_kv_cache?key=eq.special_rates`, { method: 'DELETE', headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } }); } catch (_) { /* noop */ }
}
const MEASURE_SHEET = '測定記録';
const BILL_PRICE_SHEET = '請求単価設定';
const CONFIRMED_SALES_SHEET = '売上確定';
const SETTINGS_SHEET = 'システム設定';
const BILL_PRICE_KEYS = ['am_shop','am_dokkon','am_tokushu','am_zasshi','am_kanri','pm_normal','pm_special','pm_tokushu','pm_kanri','keiba_also_pm','keiba_only','keiba_special','keiba_tokushu','keiba_kanri','kw_am_shop','kw_am_dokkon','kw_am_tokushu','kw_am_zasshi','kw_am_kanri','kw_kyori','kw_pm','kw_pm_tokushu','kw_pm_kanri'];
const BILL_PRICE_HEADERS = ['朝刊店舗','朝刊同梱','朝刊特殊','朝刊雑誌','朝刊管理費','夕刊通常','夕刊特別','夕刊特殊','夕刊管理費','競馬併用','競馬のみ','競馬特別','競馬特殊','競馬管理費','川越朝刊店舗','川越朝刊同梱','川越朝刊特殊','川越朝刊雑誌','川越朝刊管理費','川越距離増','川越夕刊/競馬','川越夕刊特殊','川越夕刊管理費'];
const CONFIRMED_SALES_HEADERS = ['年月','営業所','コース','合計金額','朝刊小計','夕刊小計','確定日時'];
const KAWAGOE_MASTER_SHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const KAWAGOE_MASTER_SHEET_NAME = 'マスタ2';

const RATE_HEADERS = ['スタッフ名','朝刊(月-金)','朝刊(土)','夕刊/競馬(月-木)','夕刊/競馬(金-土)','庫内朝刊','庫内夕刊','計算方式','個数単価','ログインID','パスワード','区分','所属会社','夕刊計算方式','夕刊個数単価','朝刊(日)','夕刊(日)','表示権限','川越朝刊曜日別','川越パターン','月給','インボイス番号','単価適用日','プランナー手当'];

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);
const SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';
// ★ SHIFT_ADMIN_PASSWORD とは分けること。
// あちらは fetch-shift / shop-master が「本物の秘密鍵」として使う変数で、
// 未設定なら弾く設計 (|| '')。ここは画面(index.html)が平文で持っている UI 用
// パスワードと突き合わせるだけなので、性質がまったく違う。
// 同じ変数を共用していたため、2026-08-13 に遮断対応で SHIFT_ADMIN_PASSWORD を
// 設定した瞬間、請求書と鍵マップの管理操作が全部 401 になった。
// 🔒 2026-10-15: 初期値('neltec2026')を削除。公開リポジトリに書かれた初期値で誰でも管理者ログインできていた
//    (SHIFT_UI_PASSWORD が未登録だったため)。未登録なら管理者パスワードでは一切入れない(fail closed)。
const ADMIN_PASSWORD = Deno.env.get('SHIFT_UI_PASSWORD') || '';
const SYNC_SECRET = Deno.env.get('SYNC_SECRET') || ''; // 会計同期cron用の秘密ヘッダ
const TOKEN_EXPIRY_MS = 12 * 60 * 60 * 1000; // 12時間

// SSO: NexPort(このEFと同一プロジェクト)の認証でパスワードを検証する。
// login_id がメール形式で、NexPortにそのアカウントがあれば、NexPortのパスワードでログイン可。
// 失敗時は false を返し、呼び出し側で従来の単価マスタ平文PWにフォールバックする。
async function verifyNexportPassword(email: string, password: string): Promise<boolean> {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    if (!url || !anon || !email.includes('@')) return false;
    const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.access_token;
  } catch (_) {
    return false;
  }
}

// ---- セッショントークン (HMAC-SHA256 署名) ----
// btoa は Latin1 のみ受け付けるので UTF-8 を経由
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin=''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g,'+').replace(/_/g,'/'));
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(payload: string): Promise<string> {
  if (!SESSION_SECRET) throw new Error('SHIFT_SESSION_SECRET not set');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function createToken(claims: any): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ ...claims, exp: Date.now() + TOKEN_EXPIRY_MS }));
  const sig = await hmacSign(payload);
  return `${payload}.${sig}`;
}
// ── 🔗 シフト表の名前の別名(2026-10-30) ──
// 単価マスタの名前を変えると、旧名のまま入っているシフト表の日が誰にも当たらず、支払明細が黙って作られない
// (「ELP」→「ELP/富岡恵理」で9月の24日分が漏れた)。改名したら旧名を別名として登録し、
// 自動確定(finalize-shift)と画面の支払計算が旧名の日も新しい名前の人に寄せる。照合キーは空白を全部除いたもの。
const aliasKey = (n: unknown) => String(n ?? '').replace(/[\s　 ]+/g, '').trim();
async function sbRest(path: string, init: RequestInit = {}): Promise<Response> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '', SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}
/** 旧名 → 新名 を別名として登録し、旧名を指していた別名も新名へ付け替える。失敗しても呼び出し元は止めない */
async function registerRename(oldName: string, newName: string, note: string, by: string): Promise<boolean> {
  const ok = aliasKey(oldName), nk = aliasKey(newName);
  if (!ok || !nk || ok === nk) return false;
  try {
    await sbRest('shift_name_aliases?on_conflict=alias_key', { method: 'POST', headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ alias_key: ok, alias: String(oldName).trim(), staff_name: String(newName).trim(), note, created_by: by }]) });
    const r = await sbRest('shift_name_aliases?select=alias_key,staff_name');
    const rows = r.ok ? (await r.json()) as any[] : [];
    for (const a of rows) {
      if (aliasKey(a.staff_name) === ok && a.alias_key !== nk) {
        await sbRest(`shift_name_aliases?alias_key=eq.${encodeURIComponent(a.alias_key)}`, { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ staff_name: String(newName).trim() }) });
      }
    }
    // 新名そのものが別名に残っていたら消す(本人の名前が別名だと自分に寄せる意味がない)
    await sbRest(`shift_name_aliases?alias_key=eq.${encodeURIComponent(nk)}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
    return true;
  } catch (_) { return false; }
}

async function verifyToken(token: string | undefined | null): Promise<any | null> {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  try {
    const expected = await hmacSign(payload);
    // 定数時間比較（短いので簡易）
    if (sig.length !== expected.length) return null;
    let diff = 0; for (let i=0;i<sig.length;i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;
    const claims = JSON.parse(b64urlDecode(payload));
    if (claims.exp && claims.exp < Date.now()) return null;
    return claims;
  } catch { return null; }
}
function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function authErr(msg = 'auth required'): Response { return jsonResp({ error: msg, code: 'AUTH_REQUIRED' }, 401); }
function forbid(msg = 'forbidden'): Response { return jsonResp({ error: msg, code: 'FORBIDDEN' }, 403); }

// claims.role: 'admin' | 'staff'  / staff の場合 claims.name = スタッフ名 / claims.biz_type / claims.is_corp_sub / claims.is_owner / claims.company
function isAdmin(c: any): boolean { return c?.role === 'admin'; }
function isCorpSub(c: any): boolean { return c?.is_corp_sub === true; }
function isCorpOwner(c: any): boolean { return c?.is_owner === true && c?.biz_type === '法人'; }
function stripStaffPrivate(r: any) {
  const { login_pw, monthly_salary, ...rest } = r;
  return rest;
}
function stripPrices(r: any) {
  return { ...r, unit_price: '', amount: '', am_weekday: '', am_weekend: '', pm_weekday: '', pm_weekend: '', warehouse_am: '', warehouse_pm: '', unit_price_pm: '', am_sunday: '', pm_sunday: '', monthly_salary: '', planner_allowance: '', site_rates: [] };
}

// ── 拠点別の単価 (2026-10-22) ─────────────────────────────────────────
// 表 shift_site_rates(service_role のみ)。単価の各行に site_rates:[...] として付けて配る。
// 計算の決まりは rateForDay(下)。同じ決まりが index.html(siteRateForDay)と finalize-shift にもある。3か所を必ずそろえる。
const SITE_RATE_FIELDS = ['am_weekday','am_weekend','am_sunday','pm_weekday','pm_weekend','pm_sunday','warehouse_am','warehouse_pm','calc_type','unit_price','calc_type_pm','unit_price_pm'];
const SITE_AREAS = ['城北','川越','立川','川崎高津'];
const normStaff = (s: unknown) => String(s ?? '').replace(/[\s　]+/g, '');
async function loadSiteRates(): Promise<Map<string, any[]>> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '', SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const r = await fetch(`${SB_URL}/rest/v1/shift_site_rates?select=*&order=effective_from.asc`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
  // 🚨 読めなかったら黙って基本の単価で計算しない(拠点別の人の支払いが静かに変わる)。呼び出し側でエラーにする
  if (!r.ok) throw new Error('拠点別の単価を読めませんでした: ' + r.status);
  const m = new Map<string, any[]>();
  for (const s of (await r.json()) as any[]) { const k = normStaff(s.staff_name); const a = m.get(k); if (a) a.push(s); else m.set(k, [s]); }
  return m;
}
async function attachSiteRates(rates: any[]): Promise<any[]> {
  const m = await loadSiteRates();
  return rates.map((r: any) => ({ ...r, site_rates: m.get(normStaff(r.name)) || [] }));
}
function siteAreaOf(course: unknown): string {
  const c = String(course ?? '').replace(/引継/g, '').trim();
  if (c.startsWith('城北')) return '城北'; if (c.startsWith('川越')) return '川越';
  if (c.startsWith('立川')) return '立川'; if (c.startsWith('川崎')) return '川崎高津';
  return '';
}
/** その日・そのコースで使う単価。拠点別の単価があれば一式を差し替える(空欄は空欄)。無ければ基本の単価そのまま */
function rateForDay(rate: any, course: unknown, ymd: unknown): any {
  const list = rate?.site_rates;
  if (!Array.isArray(list) || !list.length) return rate;
  const area = siteAreaOf(course); if (!area) return rate;
  const ym = String(ymd ?? '').replace(/\//g, '-').slice(0, 7);
  let best: any = null;
  for (const s of list) { if (s.area !== area || (s.effective_from && s.effective_from > ym)) continue; if (!best || s.effective_from > best.effective_from) best = s; }
  if (!best) return rate;
  const out: any = { ...rate, kw_pattern: '', kw_am_daily: '', site_area: area };
  for (const f of SITE_RATE_FIELDS) out[f] = best[f] ?? '';
  if (!out.calc_type) out.calc_type = '固定';
  return out;
}
// 指定メンバー(name)自身の行が permissions に 'show_money' (=本人に金額表示) を持つか
function memberShowsMoney(rates: any[], name: string): boolean {
  if (!name) return false;
  const r = rates.find((x: any) => x.name === name);
  return !!(r && (r.permissions || '').split(',').includes('show_money'));
}
// 取引先名/会社名の正規化 (法人格・記号・空白を除去して突合用キーに)
function normPartner(s: string): string {
  return String(s || '')
    .normalize('NFKC') // 半角カナ→全角・㈱→(株)・全角英数→半角 を吸収
    .replace(/株式会社|合同会社|有限会社|（株）|\(株\)|㈱|（合）|\(合\)|（有）|\(有\)/g, '')
    .replace(/[\s　・,，\.。\-－―ー]/g, '')
    .toLowerCase().trim();
}
// ---- Sheets 読み取りの共通ヘルパー ----
// Sheets がエラー(タブ名不一致=400 / 権限=403 / 一時障害=429,5xx)を返しても body に
// values が無いだけなので、 ||[] で受けると「登録0件」と区別が付かず、原因不明の空表示に
// なる (2026-08 特別日当が全件消えて見えた事象)。 失敗は握り潰さず例外にして呼び出し元へ返す。
class SheetsReadError extends Error {}
async function sheetVals(resp: Response, what = ''): Promise<any[][]> {
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new SheetsReadError(`Sheetsの読み取りに失敗しました (HTTP ${resp.status})${what ? ' / ' + what : ''}: ${String(body?.error?.message ?? '').slice(0, 200)}`);
  return body.values || [];
}

// 同じ company の名前リスト (オーナー含む) を取得 (法人オーナー権限スコープ用)
// 会社名の一致(法人格の書き方・空白・中黒・半角カナの違いは同じ会社)。
// 単価マスタの会社欄は会計マスタの正式名へ自動で置き換わる(normalize_rate_companies)ため、
// ログイン中のトークンに残った旧表記と完全一致で比べると、法人オーナーが自社メンバーを見失う。
const coKeyCmp = (v: unknown) => String(v ?? '').normalize('NFKC').replace(/[\s・.,'’`-]+/g, '')
  .replace(/株式会社|\(株\)/g, '㈱').replace(/合同会社/g, '(合)').replace(/有限会社|\(有\)/g, '㈲').toLowerCase();
const sameCo = (a: unknown, b: unknown) => !!coKeyCmp(a) && coKeyCmp(a) === coKeyCmp(b);
async function fetchCompanyNames(sheetsToken: string, company: string): Promise<string[]> {
  if (!company) return [];
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`, { headers: { 'Authorization': `Bearer ${sheetsToken}` } });
  const rows = await sheetVals(resp);
  const list = parseRates(rows).filter((r: any) => r.biz_type === '法人' && sameCo(r.company, company));
  return list.map((r: any) => r.name);
}

// ---- 既存ユーティリティ ----
function b64url(data: string): string { return btoa(data).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function getAccessToken(): Promise<string> {
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const payload=b64url(JSON.stringify({iss:SERVICE_ACCOUNT.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:SERVICE_ACCOUNT.token_uri,iat:now,exp:now+3600}));
  const pemBody=SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\n/g,'');
  const binaryDer=Uint8Array.from(atob(pemBody),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',binaryDer,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(`${header}.${payload}`));
  const signature=btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const jwt=`${header}.${payload}.${signature}`;
  const resp=await fetch(SERVICE_ACCOUNT.token_uri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`});
  const tokenJson=await resp.json().catch(()=>({}));
  // トークン取得に失敗したまま先へ進むと、後続のSheets取得が401→values空→
  // 「ID/PW間違い」と誤表示される。ここで確実に落として上位でリトライさせる。
  if(!resp.ok || !tokenJson.access_token) throw new Error(`token_fetch_failed:${resp.status}`);
  return tokenJson.access_token;
}

// Sheets値取得を一時失敗(429/5xx/トークン切れ/ネットワーク)に強くする軽リトライ。
// 成功時は values 配列を返す。全リトライ失敗時は例外を投げる(呼び出し側で503応答)。
async function fetchSheetValuesWithRetry(range: string, tokenGetter: ()=>Promise<string>, tries=3, ssId: string = SPREADSHEET_ID): Promise<any[]> {
  let lastErr: any=null;
  for(let i=0;i<tries;i++){
    try{
      const token=await tokenGetter();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(range)}`,{headers:{'Authorization':`Bearer ${token}`}});
      if(resp.ok){ const j=await resp.json().catch(()=>({})); return j.values||[]; }
      const body=await resp.text().catch(()=>'');
      lastErr=new Error(`sheet_http_${resp.status}${resp.status===429?' (Sheetsの読み取り上限。少し待つと回復します)':''}: ${body.slice(0,200)}`);
      // 429 は「1分あたりの読取上限」なので短い待ちでは明けない。 段階的に長く待つ。
      if(resp.status===429 && i<tries-1){ await new Promise(r=>setTimeout(r, 1200*(i+1))); continue; }
    }catch(e){ lastErr=e; }
    if(i<tries-1) await new Promise(r=>setTimeout(r, 300*Math.pow(2,i))); // 300ms,600ms
  }
  throw lastErr||new Error('sheet_fetch_failed');
}
function parseRates(rows: string[][]) {
  return rows.map((r:string[],i:number)=>({row_number:i+2,name:r[0]||'',am_weekday:r[1]||'',am_weekend:r[2]||'',pm_weekday:r[3]||'',pm_weekend:r[4]||'',warehouse_am:r[5]||'',warehouse_pm:r[6]||'',calc_type:r[7]||'固定',unit_price:r[8]||'',login_id:r[9]||'',login_pw:r[10]||'',biz_type:r[11]||'',company:r[12]||'',calc_type_pm:r[13]||'',unit_price_pm:r[14]||'',am_sunday:r[15]||'',pm_sunday:r[16]||'',permissions:r[17]||'',kw_am_daily:r[18]||'',kw_pattern:r[19]||'',monthly_salary:r[20]||'',invoice_number:r[21]||'',rate_effective_from:r[22]||'',planner_allowance:r[23]||''})).filter((o:any)=>o.name);
}

// 単価マスタ(A2:W1000) の DBキャッシュ。ログインが毎回 Sheets を叩いて 60読取/分 の枠を
// 食い合い「混み合っています」を頻発させるのを防ぐ緩衝。TTL内はSheets非アクセス、
// Sheets失敗時は期限切れでも旧キャッシュで凌ぐ(ログインを落とさない)。
const RATE_CACHE_TTL_MS = 10 * 60 * 1000; // 10分
async function getRateRowsCached(forceFresh = false): Promise<string[][]> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  let cached: any = null;
  if (SB_URL && SRK) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/sm_kv_cache?select=data,updated_at&key=eq.rates`, { headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } });
      if (r.ok) { const a = await r.json(); cached = Array.isArray(a) && a[0] ? a[0] : null; }
    } catch (_) { /* noop */ }
  }
  const fresh = !forceFresh && cached && cached.updated_at && Array.isArray(cached.data)
    && (Date.now() - new Date(cached.updated_at).getTime() < RATE_CACHE_TTL_MS);
  if (fresh) return cached.data as string[][];
  try {
    const rows = await fetchSheetValuesWithRetry('単価マスタ!2:1000', getAccessToken);
    if (SB_URL && SRK) {
      try {
        await fetch(`${SB_URL}/rest/v1/sm_kv_cache`, {
          method: 'POST',
          headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ key: 'rates', data: rows, updated_at: new Date().toISOString() }]),
        });
      } catch (_) { /* キャッシュ更新失敗は無視 */ }
    }
    return rows;
  } catch (e) {
    if (cached && Array.isArray(cached.data)) return cached.data as string[][]; // 期限切れでもキャッシュで凌ぐ
    throw e;
  }
}
// 単価マスタ更新時にキャッシュを破棄 → 次回ログインで最新を取り直す(編集の即時反映)。
async function invalidateRateCache(): Promise<void> {
  const SB_URL = Deno.env.get('SUPABASE_URL') || '';
  const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SB_URL || !SRK) return;
  try { await fetch(`${SB_URL}/rest/v1/sm_kv_cache?key=eq.rates`, { method: 'DELETE', headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } }); } catch (_) { /* noop */ }
}
function parseWork(rows: string[][]) {
  return rows.map((r:string[],i:number)=>({row_number:i+2,date:r[0]||'',staff:r[1]||'',course:r[2]||'',category:r[3]||'',start_time:r[4]||'',end_time:r[5]||'',quantity:r[6]||'',unit_price:r[7]||'',amount:r[8]||'',confirmed:r[9]||''})).filter((r:any)=>r.date||r.staff);
}

// 二重計上判定キー: スタッフ+日付+区分+コースを正規化して結合 (空白除去/日付-統一/区分の表記ゆれ吸収)
function workDupKey(rec: {staff?:string;date?:string;category?:string;course?:string}): string {
  const norm=(s?:string)=>String(s||'').replace(/[\s　]+/g,'').trim();
  const ndate=(s?:string)=>String(s||'').replace(/\//g,'-');
  const c=String(rec.category||'');
  const ncat = (c.includes('庫内')&&c.includes('夕')) ? '庫内夕刊' : c.includes('庫内') ? '庫内朝刊' : (c.includes('夕')||c.includes('競馬')) ? '夕刊/競馬' : '朝刊';
  return `${norm(rec.staff)}|${ndate(rec.date)}|${ncat}|${norm(rec.course)}`;
}

function normalizeYM(v: any): string {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{1,2}$/.test(s)) { const [y, m] = s.split('-'); return `${y}-${String(parseInt(m, 10)).padStart(2, '0')}`; }
  if (/^\d+(\.\d+)?$/.test(s)) { const serial = parseFloat(s); const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000; const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
  return s;
}
function parseAtMs(s: string): number { if (!s) return 0; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d.getTime()) ? 0 : d.getTime(); }

async function ensureSheets(token:string){
  const metaResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties`,{headers:{'Authorization':`Bearer ${token}`}});
  const metaSheets=((await metaResp.json()).sheets||[]);
  const existing=metaSheets.map((s:any)=>s.properties.title);
  // 単価マスタの列数が RATE_HEADERS(現在24列=A..X) に足りないと、A2:X200 の読取が
  // 「exceeds grid limits」で失敗し 単価が全件0件になる → 先に列を足しておく(自己修復)。
  {
    const rp=metaSheets.find((s:any)=>s.properties?.title==='単価マスタ')?.properties;
    const cols=Number(rp?.gridProperties?.columnCount)||0;
    if(rp&&cols&&cols<RATE_HEADERS.length){
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{appendDimension:{sheetId:rp.sheetId,dimension:'COLUMNS',length:RATE_HEADERS.length-cols}}]})});
    }
  }
  const requests:any[]=[];
  if(!existing.includes('単価マスタ'))requests.push({addSheet:{properties:{title:'単価マスタ'}}});
  if(!existing.includes('稼働記録'))requests.push({addSheet:{properties:{title:'稼働記録'}}});
  if(!existing.includes(MEASURE_SHEET))requests.push({addSheet:{properties:{title:MEASURE_SHEET}}});
  if(!existing.includes(BILL_PRICE_SHEET))requests.push({addSheet:{properties:{title:BILL_PRICE_SHEET}}});
  if(!existing.includes(CONFIRMED_SALES_SHEET))requests.push({addSheet:{properties:{title:CONFIRMED_SALES_SHEET}}});
  if(!existing.includes(SETTINGS_SHEET))requests.push({addSheet:{properties:{title:SETTINGS_SHEET}}});
  if(requests.length>0)await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requests})});
  const hr=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!1:1`,{headers:{'Authorization':`Bearer ${token}`}});
  const ch=(await hr.json()).values?.[0]||[];
  if(ch.length<RATE_HEADERS.length||!ch.includes('単価適用日')||!ch.includes('プランナー手当')){
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A1:X1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[RATE_HEADERS]})});
  }
  const wr=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A1:J1`,{headers:{'Authorization':`Bearer ${token}`}});
  const wh=(await wr.json()).values?.[0]||[];
  if(wh.length<10||!wh.includes('確定')){
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A1:J1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[['日付','スタッフ名','コース名','区分','開始時間','終了時間','配送個数','単価','金額','確定']]})});
  }
  const mr=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A1:H1`,{headers:{'Authorization':`Bearer ${token}`}});
  const mh=(await mr.json()).values?.[0]||[];
  if(mh.length<8||!mh.includes('担当者')){
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A1:H1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[['日付','コース','区分','開始時刻','終了時刻','店舗名','到着時刻','担当者']]})});
  }
  const bpr=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(BILL_PRICE_SHEET)}!A1:W1`,{headers:{'Authorization':`Bearer ${token}`}});
  const bph=(await bpr.json()).values?.[0]||[];
  if(bph.length<BILL_PRICE_KEYS.length){
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(BILL_PRICE_SHEET)}!A1:W1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[BILL_PRICE_HEADERS]})});
    const defaults=[270,50,20,130,20,230,700,20,20,230,250,700,20,20,260,50,20,80,20,13,280,20,20];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(BILL_PRICE_SHEET)}!A2:W2?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[defaults]})});
  }
  const csr=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A1:G1`,{headers:{'Authorization':`Bearer ${token}`}});
  const csh=(await csr.json()).values?.[0]||[];
  if(csh.length<7){
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A1:G1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[CONFIRMED_SALES_HEADERS]})});
  }
}

function parseYenValue(s: string): number { if(!s) return 0; return Number(s.replace(/[¥¥,]/g, '')) || 0; }

// ── 川越コース単価表 (マスタ2 の AN〜AV 列に「旧」「新」の2ブロック) ──────────────
// 以前は AN2:AV20(旧) / AN22:AV34(新) と行番号を直書きしていた。コースを追記して
// ブロックが13行/19行の枠から溢れると、溢れた分が「無い」ものとして扱われ、
// finalize 側は単価0のまま黙って支払額0で確定してしまう(2026-07 に実害)。
// 広めに読んで「コース行が途切れる最大の隙間」で旧/新に割るようにし、行数の増減で壊れないようにする。
const KW_COURSE_RANGE = 'AN1:AV300';
function splitKawagoeBlocks(rows: string[][]): { old: string[][]; new: string[][]; meta: any } {
  const isCourse = (r: string[]) => /^川越/.test(String((r || [])[0] || '').trim());
  const idx: number[] = [];
  rows.forEach((r, i) => { if (isCourse(r)) idx.push(i); });
  if (idx.length < 2) return { old: [], new: [], meta: { detected: false, reason: 'コース行が見つからない', count: idx.length } };
  // 連続するコース行の間で最も大きい隙間 = 旧ブロックと新ブロックの境目
  let gapAt = -1, gapSize = 0;
  for (let k = 1; k < idx.length; k++) {
    const g = idx[k] - idx[k - 1];
    if (g > gapSize) { gapSize = g; gapAt = k; }
  }
  if (gapSize < 2 || gapAt < 0) {
    // 隙間が無い = 1ブロックしか無い。旧扱いにして新は空(誤って新に割り当てない)
    return { old: idx.map((i) => rows[i]), new: [], meta: { detected: false, reason: '境目が見つからない(1ブロック)', count: idx.length } };
  }
  const oldIdx = idx.slice(0, gapAt), newIdx = idx.slice(gapAt);
  return {
    old: oldIdx.map((i) => rows[i]),
    new: newIdx.map((i) => rows[i]),
    meta: {
      detected: true,
      // シート上の行番号(1始まり)。想定とズレていないかの確認用
      old_rows: [oldIdx[0] + 1, oldIdx[oldIdx.length - 1] + 1],
      new_rows: [newIdx[0] + 1, newIdx[newIdx.length - 1] + 1],
      old_courses: oldIdx.map((i) => String(rows[i][0]).trim()),
      new_courses: newIdx.map((i) => String(rows[i][0]).trim()),
    },
  };
}
async function fetchKawagoeCourseRows(token: string): Promise<{ old: string[][]; new: string[][]; meta: any }> {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${KAWAGOE_MASTER_SHEET_ID}/values/${encodeURIComponent(KAWAGOE_MASTER_SHEET_NAME)}!${KW_COURSE_RANGE}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const rows = await sheetVals(resp);
  const split = splitKawagoeBlocks(rows);
  if (!split.meta.detected) console.warn('[kawagoe] ブロック検出に失敗:', JSON.stringify(split.meta));
  return split;
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const body = await req.json();
    const { action, record, row_number, row_numbers, updates, login_id, login_pw, measure_data, bill_prices, bill_conditions, confirmed_sale, year_month, area, course, admin_password, auth_token, expect_name } = body;
    // 管理者パスワード(SHIFT_UI_PASSWORD)か、管理者でログイン中のトークン(role=admin)のどちらかで通す(2026-10-15)
    const adminPwOrToken = async () => (!!ADMIN_PASSWORD && admin_password === ADMIN_PASSWORD) || isAdmin(await verifyToken(auth_token));

    // ---- 認証不要のアクション: login / admin_login ----
    if(action==='login'){
      // 🔒 2026-10-15: 失敗回数の制限。それまで何度でもパスワードを試せた。
      //    同じIDで15分に10回失敗 → 15分止める / 全体で1分に60回失敗 → 1分止める(IDを変えながらの総当たり)。
      const lid = String(login_id ?? '').trim().slice(0, 100);
      const failDb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();
      const [{ count: idFails }, { count: allFails }] = await Promise.all([
        failDb.from('shift_login_failures').select('id', { count: 'exact', head: true }).eq('login_id', lid).gte('at', agoIso(15 * 60_000)),
        failDb.from('shift_login_failures').select('id', { count: 'exact', head: true }).gte('at', agoIso(60_000)),
      ]);
      if ((idFails ?? 0) >= 10 || (allFails ?? 0) >= 60) {
        return jsonResp({success:false, error:'ログインの失敗が続いたため、しばらく受け付けを止めています。15分ほど待ってからお試しください。', code:'TOO_MANY_ATTEMPTS'}, 429);
      }
      const recordFail = async () => { try { await failDb.from('shift_login_failures').insert({ login_id: lid }); } catch (_) { /* noop */ } };
      // 単価マスタ(照合の正)は一時失敗に強い軽リトライで取得。
      // ここが取れないと誰もマッチせず「ID/PW間違い」と誤表示されるため、
      // 取得失敗と「認証情報が違う」を厳密に区別する。
      // ※ ensureSheets(=毎回6回以上のSheets読取) はログインでは呼ばない。構造は既存前提。
      //    単価マスタは DBキャッシュ経由で取得し、Sheets読取枠(60/分)の食い合いを避ける。
      let rateRows: any[];
      try{
        rateRows=await getRateRowsCached();
      }catch(e){
        // シート取得の一時障害。PWは合っているかもしれないので専用メッセージ+503。
        return jsonResp({success:false, error:'サーバが一時的に混み合っています。少し待ってからもう一度お試しください。', code:'SHEET_UNAVAILABLE'}, 503);
      }
      // SSO対応: まず login_id(ログインID列)で行を特定 → パスワードは
      //   ① 従来の単価マスタ平文PW  または  ② NexPort認証(同一プロジェクト)  のどちらか一致でOK。
      //   → NexPortのID/パスワードでも新聞にログイン可。既存のシートPW利用者も無変更。
      let row=rateRows.find((r:string[])=>(r[9]||'').trim()===login_id);
      if(!row){
        // キャッシュ未反映(単価マスタに追加直後)かもしれない → 最新を1回だけ取り直して再確認
        try{ rateRows=await getRateRowsCached(true); row=rateRows.find((r:string[])=>(r[9]||'').trim()===login_id); }catch(_){ /* noop */ }
      }
      let authOk = !!row && (row[10]||'').trim()===login_pw; // ①従来のシート平文PW
      if(row && !authOk){
        authOk = await verifyNexportPassword(login_id, login_pw); // ②NexPort認証(SSO)
      }
      if(!row || !authOk){ await recordFail(); return jsonResp({success:false,error:'IDまたはパスワードが正しくありません'}); }
      try { await failDb.from('shift_login_failures').delete().eq('login_id', lid); } catch (_) { /* noop */ }
      // 🚪 2026-10-26 退職の処理が済んだ人は入れない(退職予定 staff_retirements・EF staff-retire が退職日の翌日に処理)。
      //    新聞は単価マスタに在籍の列が無いので、ここで止める。支払明細ビューアは別のログインなので引き続き見られる。
      try {
        const nm = String(row[0] || '').replace(/[\s　]/g, '');
        const { data: ret } = await failDb.from('staff_retirements').select('full_name, shift_login_id, retire_date')
          .is('cancelled_at', null).not('processed_at', 'is', null);
        const hit = (ret ?? []).find((x: any) => (x.shift_login_id && String(x.shift_login_id) === login_id) || String(x.full_name || '').replace(/[\s　]/g, '') === nm);
        if (hit) return jsonResp({ success: false, error: `退職の手続き（${hit.retire_date}）が済んでいるため、ログインできません。支払明細は明細ビューアからご覧ください。`, code: 'RETIRED' });
      } catch (_) { /* 確認できないときは止めない */ }
      const match=row;
      // ⑤監査: 新聞ログイン権限(shift)を記録するだけ(ブロックしない)。
      try{ await fetch('https://nccognptoprhwsbjnwcu.supabase.co/functions/v1/check-login-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system:'shift',login_id,source:'shift-login',log:true})}); }catch(_){ /* noop */ }
      // 中央明細権限(meisai): 金額表示の制御に使う(明細を明示×にした人は必ず金額を隠す)。
      let meisaiChk: any = { allowed: true, reason: 'default_allow' };
      try{ meisaiChk = await fetch('https://nccognptoprhwsbjnwcu.supabase.co/functions/v1/check-login-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system:'meisai',login_id,source:'shift-money'})}).then(x=>x.json()); }catch(_){ /* noop */ }
      // claims 構築
      const name = match[0];
      const biz_type = match[11] || '';
      const company = match[12] || '';
      const permissions = match[17] || '';
      const permList = permissions.split(',');
      // 管理者 = 社員 (biz_type='社員' は自動で admin)。 旧データ互換で permissions='admin' も認める
      const has_admin = biz_type === '社員' || permList.includes('admin');
      const is_owner = biz_type === '法人' && permList.includes('owner');
      const is_corp_sub = biz_type === '法人' && !is_owner;
      // permissions に 'admin' があれば EF レベルでも admin 扱い
      const tokenRole = has_admin ? 'admin' : 'staff';
      // 拠点別の単価も付ける(稼働記録の金額の自動入力で使う)。読めなくてもログインは止めない(基本の単価で表示)
      let allRates = parseRates(rateRows);
      try{ allRates = await attachSiteRates(allRates); }catch(_e){ /* noop */ }
      // 金額表示: 明細を明示×にした人は必ず非表示。それ以外は従来(corp-subはshow_money) or 明細許可。
      const toolMoney = is_corp_sub ? permList.includes('show_money') : true;
      const company_shows_money = meisaiChk?.reason === 'explicit_deny' ? false : ((meisaiChk?.allowed ?? true) || toolMoney);
      const sessionToken = await createToken({ role: tokenRole, name, biz_type, company, permissions, is_corp_sub, is_owner, company_shows_money });
      // 単価 + 稼働のスコープ: admin=全件 / corp-owner=同company全員 / それ以外=自分のみ
      // 稼働記録は認証には不要(表示用)なので、取得できなくてもログインは通す(空扱い)。
      let workValues: any[] = [];
      try{ workValues = await getWorkRowsCached(); }catch(_e){ workValues = []; }
      const allWork = parseWork(workValues);
      let ratesScoped, myWork;
      if (has_admin) {
        ratesScoped = allRates;
        myWork = allWork;
      } else {
        const scopeNames = new Set<string>([name]);
        // オーナー or 金額表示ON配下 → 同company全員を配下スコープに含める
        if (is_owner || (is_corp_sub && company_shows_money)) {
          allRates.filter((r:any)=>r.biz_type==='法人' && r.company===company).forEach((r:any)=>scopeNames.add(r.name));
        }
        myWork = allWork.filter((w:any)=>scopeNames.has(w.staff));
        ratesScoped = allRates.filter((r:any)=>scopeNames.has(r.name)).map((r:any)=>{
          if (is_corp_sub && !company_shows_money) return stripPrices(stripStaffPrivate(r));
          return stripStaffPrivate(r);
        });
      }
      return jsonResp({success:true, staff_name:name, rates:ratesScoped, work:myWork, permissions, auth_token:sessionToken, is_owner, company, has_admin, company_shows_money});
    }
    if(action==='admin_login'){
      if(!ADMIN_PASSWORD || !admin_password || admin_password !== ADMIN_PASSWORD) return jsonResp({success:false,error:'管理者パスワードが正しくありません'},401);
      const sessionToken = await createToken({ role: 'admin', name: 'admin' });
      return jsonResp({success:true, auth_token: sessionToken});
    }

    // ── 会計ツール連携: 単価マスタの T番号(invoice_number) を Supabase テーブルへ同期 ──
    //   admin_password または cron秘密ヘッダ(x-sync-secret)でゲート。会計側は acc_shift_invoice_numbers を読むだけ。
    // ── Phase0(単価マスタSupabase移行): 単価マスタ(Sheets)→ shift_rate_master テーブルへ全リフレッシュ・ミラー ──
    //   読取専用ミラー(Sheetsが正)。login_pw(K列)は非格納。cron日次 or 管理者手動。シャドー計算の元データ。
    if(action==='sync_rate_master'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const rows = await getRateRowsCached(true); // forceFresh=Sheetsから最新
      const parsed = parseRates(rows);
      const now = new Date().toISOString();
      // 置き換える前の名前(login_id → 名前)。同じ login_id で名前が変わっていれば改名とみなして別名に登録する。
      // login_id が重複している行(同じIDを複数行で使っている)は取り違えるので見ない
      const prevRes = await fetch(`${SB_URL}/rest/v1/shift_rate_master?select=name,login_id`,{headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`}});
      const prevRows = prevRes.ok ? (await prevRes.json()) as any[] : [];
      const recs = parsed.map((o:any)=>({ row_number:o.row_number, name:o.name, am_weekday:o.am_weekday, am_weekend:o.am_weekend, pm_weekday:o.pm_weekday, pm_weekend:o.pm_weekend, warehouse_am:o.warehouse_am, warehouse_pm:o.warehouse_pm, calc_type:o.calc_type, unit_price:o.unit_price, login_id:o.login_id, biz_type:o.biz_type, company:o.company, calc_type_pm:o.calc_type_pm, unit_price_pm:o.unit_price_pm, am_sunday:o.am_sunday, pm_sunday:o.pm_sunday, permissions:o.permissions, kw_am_daily:o.kw_am_daily, kw_pattern:o.kw_pattern, monthly_salary:o.monthly_salary, invoice_number:o.invoice_number, rate_effective_from:o.rate_effective_from, planner_allowance:o.planner_allowance, synced_at:now }));
      // 全削除 → 一括挿入(冪等・全リフレッシュ)。単価マスタは~200件なので一括でOK。
      const del = await fetch(`${SB_URL}/rest/v1/shift_rate_master?name=not.is.null`,{method:'DELETE',headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`,'Prefer':'return=minimal'}});
      if(!del.ok){ const t=await del.text(); return jsonResp({error:'delete failed: '+del.status+' '+t.slice(0,200)},500); }
      if(recs.length){
        const ins = await fetch(`${SB_URL}/rest/v1/shift_rate_master`,{method:'POST',headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`,'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify(recs)});
        if(!ins.ok){ const t=await ins.text(); return jsonResp({error:'insert failed: '+ins.status+' '+t.slice(0,300)},500); }
      }
      const renamed: string[] = [];
      { const uniq = (list: any[]) => { const c = new Map<string, number>(); for (const r of list) { const id = String(r.login_id || '').trim(); if (id) c.set(id, (c.get(id) || 0) + 1); } return c; };
        const cPrev = uniq(prevRows), cNow = uniq(recs);
        const nowById = new Map(recs.map((r: any) => [String(r.login_id || '').trim(), String(r.name || '')]));
        const nowNames = new Set(recs.map((r: any) => aliasKey(r.name)));
        for (const p of prevRows) {
          const id = String(p.login_id || '').trim();
          if (!id || cPrev.get(id) !== 1 || cNow.get(id) !== 1) continue;
          const nn = nowById.get(id) || '';
          // 旧名がまだ別の行に残っている(=改名ではなく追加)なら登録しない
          if (nn && aliasKey(nn) !== aliasKey(p.name) && !nowNames.has(aliasKey(p.name))) {
            if (await registerRename(String(p.name), nn, '単価マスタの同期で改名を検知(同じログインID)', 'sync_rate_master')) renamed.push(`${p.name} → ${nn}`);
          }
        } }
      return jsonResp({success:true, synced:recs.length, renamed});
    }

    // ── 氏名の表記ゆれ検知(2026-09-01) ──
    // 氏名を鍵にしているシートが4つある(単価マスタ/月次シフト表/特別日当/人員名簿)。
    // どれか1つだけ表記を変えると、そこだけ照合が外れて金額が静かに落ちる。
    //   実例: 2026-08-13に単価マスタを「屋号/氏名」へ統一 → 特別日当シートが旧表記のまま残り、
    //         TLCの日曜特別日当 7,000円×5週が8月分の請求・支払に乗らなくなった(9/1に発覚)。
    // 単価マスタを正として、他3シートの氏名を突合する。判定は「単価マスタに無い」かつ
    // 「空白・区切り記号・異体字を無視すると一致する候補がある」= 表記ゆれ。
    if(action==='name_consistency'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const VAR: Record<string,string> = {'齋':'斉','斎':'斉','齊':'斉','髙':'高','﨑':'崎','嵜':'崎','濵':'浜','濱':'浜','邊':'辺','邉':'辺','澤':'沢','瀨':'瀬','眞':'真','德':'徳','冨':'富','栁':'柳','郞':'郎','薗':'園','曻':'昇'};
      const fold=(n:string)=>String(n||'').replace(/[\s　 ]+/g,'').replace(/[齋斎齊髙﨑嵜濵濱邊邉澤瀨眞德冨栁郞薗曻]/g,c=>VAR[c]||c).trim();
      const loose=(n:string)=>fold(n).replace(/[.．/／・]+/g,'');   // 区切りも無視した緩いキー
      const tok=await getAccessToken();
      const grab=async(ssId:string,range:string)=>{
        const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(range)}`,{headers:{'Authorization':`Bearer ${tok}`}});
        if(!r.ok)return [] as string[][];
        return ((await r.json()).values ?? []) as string[][];
      };
      // 正 = 単価マスタ A列
      const rateRows=await grab(SPREADSHEET_ID,'単価マスタ!A2:A300');
      const master=rateRows.map(r=>String(r?.[0]||'').trim()).filter(Boolean);
      const exact=new Set(master.map(fold));
      const byLoose=new Map<string,string>();
      master.forEach(m=>{ const k=loose(m); if(k&&!byLoose.has(k))byLoose.set(k,m); });
      const issues:{source:string;name:string;master:string;detail:string}[]=[];
      const check=(source:string,name:string,detail:string)=>{
        const n=String(name||'').trim(); if(!n)return;
        if(exact.has(fold(n)))return;                 // 完全一致(表記ゆれ無し)
        const hit=byLoose.get(loose(n));
        if(hit)issues.push({source,name:n,master:hit,detail});   // 区切り/字体だけ違う = 表記ゆれ
      };
      // 特別日当(フォーム回答) C列 = 氏名。直近90日分だけ見る(過去の確定分は触らない)
      const spRows=await grab(SPECIAL_SHEET_ID,`${SPECIAL_SHEET_NAME}!B2:C5000`);
      const limit=new Date(Date.now()-90*86400000).toISOString().slice(0,10).replace(/-/g,'/');
      const spSeen=new Set<string>();
      for(const r of spRows){
        const d=String(r?.[0]||'').replace(/-/g,'/'), nm=String(r?.[1]||'').trim();
        if(!nm||d<limit)continue;
        if(spSeen.has(nm))continue; spSeen.add(nm);
        check('特別日当',nm,`直近90日で使用`);
      }
      // 人員名簿 C列 = 氏名
      const rosRows=await grab(ROSTER_SHEET_ID,`${ROSTER_SHEET_NAME}!A2:D3000`);
      const rosSeen=new Set<string>();
      for(const r of rosRows){
        const nm=String(r?.[2]||'').trim(); if(!nm||rosSeen.has(nm))continue; rosSeen.add(nm);
        check('人員名簿',nm,String(r?.[0]||''));
      }
      // 当月・翌月のシフト表(氏名がセルに直接入る)
      const now=new Date(Date.now()+9*3600000);
      for(const add of [0,1]){
        const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+add,1));
        const title=`${d.getUTCMonth()+1}月シフト${d.getUTCFullYear()}`;
        const cells=await grab(ROSTER_SHEET_ID,`${title}!A1:BZ400`);
        if(!cells.length)continue;
        const seen=new Set<string>();
        for(const row of cells)for(const c of (row||[])){
          const v=String(c||'').trim();
          if(!v||v.length<2||v.length>24||seen.has(v))continue;
          if(/^[0-9０-９:：\/\-\.]+$/.test(v))continue;   // 日付・数値・コース番号は対象外
          seen.add(v); check(title,v,'シフト表のセル');
        }
      }
      return jsonResp({ok:true,checked:{master:master.length},issues,count:issues.length});
    }

    // ── 電話番号の相違検知(2026-10-19) ──
    // 新聞の電話は 単価マスタ J列(ログインID)・人員名簿 D列 の2か所にあり、中央人材マスタ・NexPort とも
    // 独立に入力される。どれかが別の番号だと、明細ビューアや支払通知の本人照合が外れたり、
    // 別人の番号で明細が引ける事故になる(2026-09分で7名がビューアに出なかった)。
    // 先頭0落ち・+81・ハイフンは fixJpPhone で揃えてから比べる(=表記違いは相違にしない)。
    // ログインIDがメール形式の人(NexPort SSO)はログインIDを電話として扱わない。
    if(action==='phone_consistency' || action==='fix_staff_phone'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(action==='fix_staff_phone' ? !(await adminPwOrToken()) : (!okCron && !(await adminPwOrToken()))) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const H = { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } as Record<string,string>;
      const tok=await getAccessToken();
      const isPhone=(v:string)=>/^0\d{9,10}$/.test(v);
      const asPhone=(v:unknown)=>{ const s=String(v??'').trim(); if(!s||s.includes('@'))return ''; const p=fixJpPhone(s); return isPhone(p)?p:''; };
      const [rateRes,rosRes,smRes,nxRes]=await Promise.all([
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:300`,{headers:{'Authorization':`Bearer ${tok}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}/values/${encodeURIComponent(ROSTER_SHEET_NAME)}!A2:D3000`,{headers:{'Authorization':`Bearer ${tok}`}}),
        fetch(`${SB_URL}/rest/v1/staff_master?select=full_name,phone,shift_login_id,profile_id,hidden`,{headers:H}),
        fetch(`${SB_URL}/rest/v1/profiles?select=id,phone`,{headers:H}),
      ]);
      const rates=parseRates(await sheetVals(rateRes));
      const rosRows=(await sheetVals(rosRes)) as string[][];
      const sm=((smRes.ok?await smRes.json():[]) as any[]).filter((r)=>!r.hidden);
      const nxPhone=new Map<string,string>(); for(const p of (nxRes.ok?await nxRes.json():[]) as any[]){ const ph=asPhone(p.phone); if(ph)nxPhone.set(p.id,ph); }
      const smByLogin=new Map<string,any>(); const smByName=new Map<string,any[]>();
      for(const r of sm){ if(r.shift_login_id)smByLogin.set(String(r.shift_login_id).trim(),r); const k=rosterNameKey(r.full_name); if(k){ if(!smByName.has(k))smByName.set(k,[]); smByName.get(k)!.push(r); } }
      const rosByName=new Map<string,{row:number,raw:string,phone:string}[]>();
      rosRows.forEach((r,i)=>{ const k=rosterNameKey(r?.[2]); if(!k)return; if(!rosByName.has(k))rosByName.set(k,[]); rosByName.get(k)!.push({row:i+2,raw:String(r?.[3]??'').trim(),phone:asPhone(r?.[3])}); });
      const rateNameCount=new Map<string,number>(); rates.forEach((r:any)=>{ const k=rosterNameKey(r.name); rateNameCount.set(k,(rateNameCount.get(k)||0)+1); });
      const items:any[]=[];
      for(const r of rates as any[]){
        const k=rosterNameKey(r.name); if(!k)continue;
        const lid=String(r.login_id||'').trim();
        // 中央人材マスタ: ログインIDで一致 → 無ければ氏名が一意な時だけ
        let m=lid?smByLogin.get(lid):undefined;
        if(!m){ const c=smByName.get(k)||[]; if(c.length===1 && rateNameCount.get(k)===1) m=c[0]; }
        const ros=(rateNameCount.get(k)===1)?(rosByName.get(k)||[]):[]; // 同姓同名は名簿をどちらの人か決められない
        const vals={ login:asPhone(lid), roster:ros.map(x=>x.phone).filter(Boolean), master:asPhone(m?.phone), nexport:m?.profile_id?(nxPhone.get(m.profile_id)||''):'' };
        const all=new Set<string>([vals.login,...vals.roster,vals.master,vals.nexport].filter(Boolean));
        if(all.size<=1)continue;
        items.push({ name:r.name, row_number:r.row_number, login_id:lid, login_is_email:lid.includes('@'), roster_rows:ros.map(x=>({row:x.row,raw:x.raw,phone:x.phone})), master:vals.master, nexport:vals.nexport, login:vals.login, candidates:[...all] });
      }
      if(action==='phone_consistency') return jsonResp({ok:true,checked:rates.length,items,count:items.length});

      // ── 修正: 相違がある人だけ、候補の番号のどれかに直す。シートは文字列(')で書き先頭0を守る ──
      const target=String(body.target||''); const want=fixJpPhone(String(body.phone||''));
      const it=items.find((x)=>x.name===String(body.name||''));
      if(!it) return jsonResp({error:'この方は今、電話番号の相違がありません(画面を更新してください)'},409);
      if(!isPhone(want) || !it.candidates.includes(want)) return jsonResp({error:'候補にない番号には直せません'},400);
      if(target==='roster'){
        const rows=(it.roster_rows as any[]).filter((x)=>x.phone!==want);
        if(!rows.length) return jsonResp({error:'人員名簿はすでにこの番号です'},409);
        const data=rows.map((x)=>({range:`${ROSTER_SHEET_NAME}!D${x.row}`,values:[[`'${want}`]]}));
        const w=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data})});
        if(!w.ok) return jsonResp({error:'人員名簿の書き込みに失敗: '+(await w.text()).slice(0,200)},500);
        return jsonResp({success:true,updated:rows.map((x)=>x.row)});
      }
      if(target==='login'){
        if(it.login_is_email) return jsonResp({error:'ログインIDがメール形式の方は対象外です'},400);
        if(it.login===want) return jsonResp({error:'ログインIDはすでにこの番号です'},409);
        // ログインIDは一意でないと別人としてログインできてしまう。表記違い(0の有無)も同一とみなす。
        const clash=(rates as any[]).find((r)=>r.row_number!==it.row_number && asPhone(r.login_id)===want);
        if(clash) return jsonResp({error:`この番号は「${clash.name}」のログインIDに使われています`},409);
        const w=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!J${it.row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[[`'${want}`]]})});
        if(!w.ok) return jsonResp({error:'単価マスタの書き込みに失敗: '+(await w.text()).slice(0,200)},500);
        await invalidateRateCache();
        return jsonResp({success:true,login_id:want});
      }
      return jsonResp({error:'target は roster か login'},400);
    }

    // ── 単価マスタの会社欄を会計マスタの正式名へそろえる(2026-10-19) ──
    // 会計で法人を正式登録(名前の修正・別名の追加を含む)したら、新聞にも自動で効かせる。
    // 規則は自動確定(finalize-shift)と同じ: ① 別名(company_aliases)→正式名 ③ 会計マスタの表記へ。
    // ② 営業所・荷主名(城北 等)は単価マスタでは社員の所属として使われているので、ここでは消さない。
    // 会計の正式登録時と毎日の staff-master-sync から呼ばれる。dry_run=true なら書かずに一覧だけ返す。
    if(action==='normalize_rate_companies'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const H = { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } as Record<string,string>;
      const coKeyAcc=(v:unknown)=>String(v??'').normalize('NFKC').replace(/[\s・.,'’`-]+/g,'')
        .replace(/株式会社|\(株\)/g,'㈱').replace(/合同会社/g,'(合)').replace(/有限会社|\(有\)/g,'㈲').toLowerCase();
      const [ipR,alR]=await Promise.all([
        fetch(`${SB_URL}/rest/v1/acc_invoice_partners?select=name`,{headers:H}),
        fetch(`${SB_URL}/rest/v1/company_aliases?select=alias,canonical`,{headers:H}),
      ]);
      const canon=new Map<string,string>(); for(const r of (ipR.ok?await ipR.json():[]) as any[]){const n=String(r.name??'').trim(); if(n&&!canon.has(coKeyAcc(n)))canon.set(coKeyAcc(n),n);}
      const alias=new Map<string,string>(); for(const r of (alR.ok?await alR.json():[]) as any[]){const a=String(r.alias??'').trim(),c=String(r.canonical??'').trim(); if(a&&c)alias.set(coKeyAcc(a),c);}
      const tok=await getAccessToken();
      const rows=parseRates(await sheetVals(await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:300`,{headers:{'Authorization':`Bearer ${tok}`}})));
      const changes:{row:number;name:string;from:string;to:string}[]=[];
      for(const r of rows as any[]){
        const raw=String(r.company||'').trim(); if(!raw)continue;
        const a=alias.get(coKeyAcc(raw))??raw;
        const to=canon.get(coKeyAcc(a));
        if(to && to!==raw) changes.push({row:r.row_number,name:r.name,from:raw,to});
      }
      if(body.dry_run||!changes.length) return jsonResp({ok:true,dry_run:!!body.dry_run,changes});
      // M列=所属会社。値だけ書く(RAW)。
      const w=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${tok}`,'Content-Type':'application/json'},
        body:JSON.stringify({valueInputOption:'RAW',data:changes.map(c=>({range:`'単価マスタ'!M${c.row}`,values:[[c.to]]}))})});
      if(!w.ok) return jsonResp({error:'単価マスタの書き込みに失敗: '+(await w.text()).slice(0,200)},500);
      await invalidateRateCache();
      return jsonResp({ok:true,changes});
    }

    // ── Phase1(シャドー監視): 単価マスタ(Sheets 最新) と ミラー(shift_rate_master) を突合し差分をログ ──
    //   本番数値は一切変えない(log専用)。差分ゼロが3ヶ月続けば「取得元をSupabaseに替えても計算不変」と証明。
    if(action==='check_rate_parity'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const H = { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } as Record<string,string>;
      const sheet = parseRates(await getRateRowsCached(true)); // Sheets最新(本番が使う値)
      const mr = await fetch(`${SB_URL}/rest/v1/shift_rate_master?select=*`, { headers: H });
      const mirror: any[] = mr.ok ? await mr.json() : [];
      const CALC_FIELDS = ['am_weekday','am_weekend','pm_weekday','pm_weekend','warehouse_am','warehouse_pm','calc_type','unit_price','biz_type','company','calc_type_pm','unit_price_pm','am_sunday','pm_sunday','permissions','kw_am_daily','kw_pattern','monthly_salary','invoice_number','rate_effective_from','planner_allowance'];
      const mMap = new Map(mirror.map((r:any)=>[String(r.name), r]));
      const sMap = new Map(sheet.map((r:any)=>[String(r.name), r]));
      const now = new Date().toISOString();
      const diffs: any[] = [];
      for(const s of sheet){
        const m = mMap.get(String(s.name));
        if(!m){ diffs.push({checked_at:now,name:s.name,field:'*',sheet_value:'(exists)',mirror_value:null,kind:'missing_in_mirror'}); continue; }
        for(const f of CALC_FIELDS){ if(String((s as any)[f]??'') !== String(m[f]??'')) diffs.push({checked_at:now,name:s.name,field:f,sheet_value:String((s as any)[f]??''),mirror_value:String(m[f]??''),kind:'value_diff'}); }
      }
      for(const m of mirror){ if(!sMap.has(String(m.name))) diffs.push({checked_at:now,name:m.name,field:'*',sheet_value:null,mirror_value:'(exists)',kind:'missing_in_sheet'}); }
      if(diffs.length){ await fetch(`${SB_URL}/rest/v1/rate_shadow_diffs`,{method:'POST',headers:{...H,'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify(diffs)}); }
      await fetch(`${SB_URL}/rest/v1/rate_shadow_runs`,{method:'POST',headers:{...H,'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify([{ran_at:now,staff_checked:sheet.length,diff_count:diffs.length,clean:diffs.length===0}])});
      return jsonResp({success:true, staff_checked:sheet.length, mirror_count:mirror.length, diff_count:diffs.length, clean:diffs.length===0, sample:diffs.slice(0,10)});
    }

    // ── Phase1: シャドー監視の状態(連続クリーン日数・直近差分)を返す(管理画面表示用・読取のみ) ──
    if(action==='rate_parity_status'){
      if(!(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const H = { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } as Record<string,string>;
      const runsRes = await fetch(`${SB_URL}/rest/v1/rate_shadow_runs?select=ran_at,staff_checked,diff_count,clean&order=ran_at.desc&limit=120`, { headers: H });
      const runs: any[] = runsRes.ok ? await runsRes.json() : [];
      let streak = 0; for(const r of runs){ if(r.clean) streak++; else break; }
      const diffRes = await fetch(`${SB_URL}/rest/v1/rate_shadow_diffs?select=name,field,sheet_value,mirror_value,kind,checked_at&order=checked_at.desc&limit=20`, { headers: H });
      const recentDiffs = diffRes.ok ? await diffRes.json() : [];
      const mrRes = await fetch(`${SB_URL}/rest/v1/shift_rate_master?select=synced_at&order=synced_at.desc&limit=1`, { headers: H });
      const syncedAt = mrRes.ok ? (((await mrRes.json())[0])||{}).synced_at : null;
      return jsonResp({success:true, last_run:runs[0]||null, clean_streak:streak, total_runs:runs.length, mirror_synced_at:syncedAt, recent_diffs:recentDiffs});
    }

    if(action==='sync_invoice_numbers'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const token = await getAccessToken();
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${token}`}});
      const rates = parseRates(await sheetVals(resp));
      const seen = new Set<string>();
      const recs = rates.filter((r:any)=>r.name && (r.invoice_number||'').trim()).map((r:any)=>({
        name: String(r.name).trim(),
        invoice_number: String(r.invoice_number).trim(),
        company: (r.company||'').trim() || null,
        updated_at: new Date().toISOString(),
      })).filter((r:any)=>{ if(seen.has(r.name))return false; seen.add(r.name); return true; });
      if(recs.length){
        const up = await fetch(`${SB_URL}/rest/v1/acc_shift_invoice_numbers`,{
          method:'POST',
          headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'},
          body: JSON.stringify(recs),
        });
        if(!up.ok){ const t=await up.text(); return jsonResp({error:'db upsert failed: '+up.status+' '+t.slice(0,300)},500); }
      }
      return jsonResp({success:true, synced:recs.length});
    }

    // ── 会計→現場 反映: acc_invoice_partners の T番号 を 単価マスタ(invoice_number) へ書き戻す ──
    //   会計が正。正規化名で 単価マスタの name または company に一致する行へセット。dry_run でプレビューのみ。
    if(action==='reflect_invoice_numbers'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const dryRun = !!body.dry_run;
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const pr = await fetch(`${SB_URL}/rest/v1/acc_invoice_partners?select=name,invoice_number`,{headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`}});
      const partners = (await pr.json()) as any[];
      const pmap = new Map<string,string>();
      partners.forEach((p:any)=>{ const t=(p.invoice_number||'').trim(); if(t) pmap.set(normPartner(p.name), t); });
      const token = await getAccessToken();
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${token}`}});
      const rates = parseRates(await sheetVals(resp));
      const data:any[] = [];
      const changes:any[] = [];
      for(const r of rates){
        if(!r.name) continue;
        const tno = pmap.get(normPartner(r.name)) || (r.company ? pmap.get(normPartner(r.company)) : undefined);
        if(!tno) continue;
        if((r.invoice_number||'').trim() === tno) continue; // 既に同値
        changes.push({ row: r.row_number, name: r.name, company: r.company||'', invoice_number: tno });
        data.push({ range: `'単価マスタ'!V${r.row_number}`, values: [[tno]] });
      }
      if(!dryRun && data.length){
        await invalidateWorkCache(); // 稼働記録を書き換えるので一覧キャッシュを破棄
        const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{
          method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
          body: JSON.stringify({ valueInputOption:'USER_ENTERED', data }),
        });
        if(!up.ok){ const t=await up.text(); return jsonResp({error:'sheet update failed: '+up.status+' '+t.slice(0,300)},500); }
      }
      // ── アスクル/配送 profiles へも反映 (別プロジェクト。service_role キーを env から) ──
      const profileTargets = [
        { name:'askul',    url: Deno.env.get('ASKUL_URL')||'',    key: Deno.env.get('ASKUL_SERVICE_KEY')||'' },
        { name:'delivery', url: Deno.env.get('DELIVERY_URL')||'', key: Deno.env.get('DELIVERY_SERVICE_KEY')||'' },
      ];
      const profiles:any = {};
      for(const t of profileTargets){
        if(!t.url || !t.key){ profiles[t.name] = { skipped:true }; continue; }
        try{
          const pres = await fetch(`${t.url}/rest/v1/profiles?select=id,full_name,company_name,invoice_number`,{headers:{'apikey':t.key,'Authorization':`Bearer ${t.key}`}});
          if(!pres.ok){ profiles[t.name] = { error: 'fetch '+pres.status }; continue; }
          const profs = (await pres.json()) as any[];
          let updated = 0; const pchanges:any[] = [];
          for(const m of profs){
            const tno = pmap.get(normPartner(m.full_name)) || (m.company_name ? pmap.get(normPartner(m.company_name)) : undefined);
            if(!tno) continue;
            if((m.invoice_number||'').trim() === tno) continue;
            pchanges.push({ name: m.full_name||m.company_name||'', invoice_number: tno });
            if(!dryRun){
              const pu = await fetch(`${t.url}/rest/v1/profiles?id=eq.${encodeURIComponent(m.id)}`,{
                method:'PATCH', headers:{'apikey':t.key,'Authorization':`Bearer ${t.key}`,'Content-Type':'application/json','Prefer':'return=minimal'},
                body: JSON.stringify({ invoice_number: tno }),
              });
              if(pu.ok) updated++;
            } else updated++;
          }
          profiles[t.name] = { updated, changes: pchanges };
        }catch(e){ profiles[t.name] = { error: String((e as any)?.message||e) }; }
      }
      return jsonResp({success:true, dry_run:dryRun, shift_updated:data.length, changes, profiles});
    }

    // ── 稼働記録の金額を単価マスタで一括再計算 (夜間cron用) ──
    //   固定/個数/曜日別朝刊/夕刊/庫内 + 特別単価 + 引継半額 + 単価適用日 を入力時(invSaveWork)と同一ロジックで計算。
    //   個建(店舗マスタ依存)・川越コース別(コースマスタ依存) は自動対象外(入力時の値を維持)。確定済みは触らない。
    if(action==='recompute_amounts'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const dryRun = !!body.dry_run;
      const onlyZero = body.only_zero !== false; // 既定true: 金額0の未計算行のみ補完(既存の非0金額は触らない=履歴保護)
      const token = await getAccessToken();
      const [rRes, wRes, sRes, kwBlocks] = await Promise.all([
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPECIAL_SHEET_ID}/values/${encodeURIComponent(SPECIAL_SHEET_NAME)}!A2:J5000`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetchKawagoeCourseRows(token),
      ]);
      let rates: any[];
      try{ rates = await attachSiteRates(parseRates(await sheetVals(rRes))); }
      catch(e){ return jsonResp({error:String((e as any)?.message||e)},503); }
      const work = parseWork(await sheetVals(wRes));
      // 川越コース別単価マスタ (旧/新) を course→曜日単価 のMapに。朝刊のコース別自動単価に使う。
      const dowKey = ['sun','mon','tue','wed','thu','fri','sat'];
      const parseKwCourses = (rows:string[][]) => {
        const m = new Map<string, any>();
        (rows||[]).filter((r:string[])=>r[0]).forEach((r:string[])=>{
          m.set(r[0], {mon:parseYenValue(r[2]),tue:parseYenValue(r[3]),wed:parseYenValue(r[4]),thu:parseYenValue(r[5]),fri:parseYenValue(r[6]),sat:parseYenValue(r[7]),sun:parseYenValue(r[8])});
        });
        return m;
      };
      const kwCourseMap: Record<string, Map<string,any>> = {
        '旧': parseKwCourses(kwBlocks.old),
        '新': parseKwCourses(kwBlocks.new),
      };
      const rateByName = new Map<string,any>(rates.map((r:any)=>[r.name, r]));
      const nn = (s:string)=>String(s||'').replace(/[\s　]+/g,'').trim();
      // 特別単価を (日付|氏名) でインデックス化 (O(1)照合)
      const specIndex = new Map<string, any[]>();
      ((await sheetVals(sRes)) as string[][]).filter(r=>r[1]&&r[2]).forEach(r=>{
        const k=`${(r[1]||'').replace(/-/g,'/')}|${nn(r[2]||'')}`;
        const o={amount:r[3]||'',category:r[6]||'',type:r[7]||''};
        const arr=specIndex.get(k); if(arr)arr.push(o); else specIndex.set(k,[o]);
      });
      const INV_CATS = ['朝刊','夕刊/競馬','庫内朝刊','庫内夕刊'];
      const mapCat = (c:string)=>{ c=String(c||''); if(INV_CATS.includes(c))return c; if(c.includes('庫内')&&c.includes('夕'))return '庫内夕刊'; if(c.includes('庫内'))return '庫内朝刊'; if(c.includes('夕')||c.includes('競馬'))return '夕刊/競馬'; return '朝刊'; };
      const data:any[] = []; const sample:any[] = [];
      let skipKodate=0, skipKw=0, skipConf=0, skipEff=0, noRate=0, skipNonzero=0;
      for(const w of work){
        if(!w.staff) continue;
        const baseRate = rateByName.get(w.staff); if(!baseRate){ noRate++; continue; }
        if((w.confirmed||'').toString().trim()){ skipConf++; continue; }
        const eff = (baseRate.rate_effective_from||'').replace(/\//g,'-');
        const rate = rateForDay(baseRate, w.course, w.date);   // 拠点別の単価があればその拠点の一式
        if(eff && (w.date||'').replace(/\//g,'-') < eff){ skipEff++; continue; }
        const cat = mapCat(w.category);
        const courseV = w.course||'';
        const isPm = cat==='夕刊/競馬'||cat==='庫内夕刊';
        const cType = isPm ? (rate.calc_type_pm||rate.calc_type) : rate.calc_type;
        if(cType==='個建'){ skipKodate++; continue; } // 個建は店舗マスタ依存のため引き続き対象外
        const d = new Date((w.date||'').replace(/\//g,'-')); const dow = d.getDay();
        let price = 0;
        if(cat==='朝刊'){
          // 川越パターン(旧/新)+コースが「川越」始まりなら、コース別曜日単価をマスタから自動適用 (入力時 invComputeRow と同一)
          let kwCP = 0;
          const kwPat = rate.kw_pattern||'';
          if(kwPat && courseV.startsWith('川越')){ const fd = kwCourseMap[kwPat]?.get(courseV); if(fd) kwCP = Number(fd[dowKey[dow]])||0; }
          if(kwCP){ price = kwCP; }
          else{
            const kwD=(rate.kw_am_daily||'').split(','); const kwM=[6,0,1,2,3,4,5];
            const kwP=kwD[kwM[dow]];
            if(kwP) price=Number(kwP)||0;
            else if(dow===0 && rate.am_sunday) price=Number(rate.am_sunday)||0;
            else price=Number((dow>=1&&dow<=5)?rate.am_weekday:rate.am_weekend)||0;
          }
        } else if(cat==='夕刊/競馬'){ if(dow===0 && rate.pm_sunday) price=Number(rate.pm_sunday)||0; else price=Number((dow>=1&&dow<=4)?rate.pm_weekday:rate.pm_weekend)||0; }
        else if(cat==='庫内朝刊') price=Number(rate.warehouse_am)||0;
        else if(cat==='庫内夕刊') price=Number(rate.warehouse_pm)||0;
        const uPrice = isPm ? (Number(rate.unit_price_pm)||Number(rate.unit_price)||0) : (Number(rate.unit_price)||0);
        let amount = 0;
        if(cType==='個数'){ const q=Number(w.quantity)||0; price=uPrice; amount=uPrice*q; } else amount=price;
        if(courseV.includes('引継')) amount=Math.floor(amount/2);
        const specCat = cat.includes('朝')?'朝刊':'夕刊';
        const sp = (specIndex.get(`${(w.date||'').replace(/-/g,'/')}|${nn(w.staff)}`)||[]).filter(s=>(s.category||'').includes(specCat));
        let add=0, rep=0; sp.forEach(s=>{ const a=Number((s.amount||'').replace(/,/g,''))||0; if(s.type==='日当')rep+=a; else if(s.type==='日当+')add+=a; });
        if(rep) amount=rep; amount+=add;
        if(Number(w.amount||0)!==Number(amount||0) || Number(w.unit_price||0)!==Number(price||0)){
          if(onlyZero && Number(w.amount||0)!==0){ skipNonzero++; continue; } // 既存の非0金額は保護(履歴・適用日)
          if(onlyZero && Number(amount||0)===0){ continue; } // 0→0は無視
          if(sample.length<10) sample.push({row:w.row_number,staff:w.staff,date:w.date,from:Number(w.amount||0),to:amount});
          data.push({ range: `'稼働記録'!H${w.row_number}:I${w.row_number}`, values: [[ String(price), String(amount) ]] });
        }
      }
      if(!dryRun && data.length){
        await invalidateWorkCache(); // 稼働記録を書き換えるので一覧キャッシュを破棄
        for(let i=0;i<data.length;i+=400){
          const chunk=data.slice(i,i+400);
          const up=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data:chunk})});
          if(!up.ok){ const t=await up.text(); return jsonResp({error:'recompute batch failed: '+up.status+' '+t.slice(0,300)},500); }
        }
      }
      return jsonResp({success:true, dry_run:dryRun, only_zero:onlyZero, updated:data.length, skipped:{kodate:skipKodate,kawagoe:skipKw,confirmed:skipConf,effective:skipEff,noRate,nonzero:skipNonzero}, sample});
    }

    // ── 会計ツール連携: 確定売上を営業所別に合算して返す (支払計算書の東京即売売上を自動入力) ──
    //   x-sync-secret(SYNC_SECRET) または admin_password でゲート。会計側は grand_total(税抜)合計を営業所別に受け取る。
    if(action==='confirmed_sales_by_area'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const ym = normalizeYM(year_month);
      if(!ym) return jsonResp({error:'year_month required'},400);
      const token = await getAccessToken();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:P5000`,{headers:{'Authorization':`Bearer ${token}`}});
      const rows=await sheetVals(resp);
      // (ym,area,course) の最新行のみ採用 (get_confirmed_sales と同じ重複排除)
      const dedup=new Map<string,{area:string;grand:number;atMs:number}>();
      rows.forEach((r:string[])=>{
        if(normalizeYM(r[0])!==ym) return; const area=(r[1]||'').trim(); const course=(r[2]||'').trim(); if(!area||!course) return;
        const atMs=parseAtMs(r[6]||''); const k=`${area}|${course}`; const ex=dedup.get(k);
        if(!ex||atMs>=ex.atMs) dedup.set(k,{area,grand:Number(r[3])||0,atMs});
      });
      const byArea:Record<string,number>={};
      dedup.forEach(v=>{ byArea[v.area]=(byArea[v.area]||0)+v.grand; });

      // ── 追加請求行(コース外)を足す ──
      // 確定(save_confirmed_sale)はコース単位なので、請求書の営業所合計に載る
      // 返品新聞作業料・庫内作業費・優馬直送便が確定に入らない。これを会計へ
      // 渡さないと、毎月その分だけ売上が不足する(2026-07 立川 450,572 / 高津 184,368)。
      // 画面(admBillAreaTotal)と同じ規則で請求条件から計算する。
      const extras:Record<string,number>={};
      const extraDetail:Record<string,{label:string;amount:number}[]>={};
      try{
        const SB_URL = Deno.env.get('SUPABASE_URL') || '';
        const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
        if(SB_URL && SRK){
          const cr = await fetch(`${SB_URL}/rest/v1/bill_conditions?select=conditions&month_val=eq.${encodeURIComponent(ym)}`,{headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`}});
          const carr = cr.ok ? await cr.json() : [];
          const cond:any = (carr && carr[0] && carr[0].conditions) || {};
          const [yy,mm] = ym.split('-').map(Number);
          const daysInMonth = new Date(yy, mm, 0).getDate();
          const holiday:number[] = cond.holiday || [];
          const noam:number[] = cond.noam || [];
          const nopm:number[] = cond.nopm || [];
          const yeskeiba:number[] = cond.yeskeiba || [];
          let amDays=0, keibaWorkDays=0;
          for(let d=1;d<=daysInMonth;d++){
            const dow=new Date(yy,mm-1,d).getDay();
            const isHoliday=holiday.includes(d);
            if(!isHoliday && !noam.includes(d)) amDays++;
            // 競馬配送日: 金・土 + yeskeiba (月〜木は夕刊で競馬配送なし)
            const isKeibaDispatch=(dow===5||dow===6||yeskeiba.includes(d)) && !nopm.includes(d);
            if(!isHoliday && isKeibaDispatch) keibaWorkDays++;
          }
          const push=(area:string,label:string,amount:number)=>{
            if(!amount) return;
            extras[area]=(extras[area]||0)+amount;
            (extraDetail[area]=extraDetail[area]||[]).push({label,amount});
          };
          push('立川','返品新聞 開梱+カゴ分け作業料', Number(cond.work_tachikawa)||0);
          push('立川',`庫内作業費(朝刊) ${amDays}日×6,000`, amDays*6000);
          push('立川',`庫内作業費(競馬) ${keibaWorkDays}日×9,000`, keibaWorkDays*9000);
          push('川崎高津','返品新聞 開梱+カゴ分け作業料', Number(cond.work_kawasaki)||0);
          push('川崎高津',`優馬直送便 ${keibaWorkDays}日×7,000`, keibaWorkDays*7000);
        }
      }catch(_){ /* 追加分が取れなくてもコース分は返す */ }

      const byAreaCourses:Record<string,number>={...byArea};
      Object.entries(extras).forEach(([a,v])=>{ if(byArea[a]!==undefined) byArea[a]=byArea[a]+v; });
      return jsonResp({year_month:ym, by_area:byArea, by_area_courses:byAreaCourses, extras, extra_detail:extraDetail});
    }

    // ── 氏名だけを書き換える (A列のみ) ──────────────────────────────────
    //  save_rate は行まるごと(A:X)を上書きするため、login_pw(K列)を渡し忘れると
    //  本人のログインパスワードが消える。parseRates は login_pw を返さないので
    //  読み直して補うこともできない。氏名の表記統一は A列だけ触れば済むので分ける。
    //  行番号は位置ベースなので、delete_rate と同じく expect_name で現物を照合してから書く。
    if(action==='rename_rate'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && !(await adminPwOrToken())) return jsonResp({error:'forbidden'},403);
      const newName = String(record?.name ?? '').trim();
      const expName = String(expect_name ?? '').trim();
      if(!row_number) return jsonResp({error:'row_number required'}, 400);
      if(!newName) return jsonResp({error:'record.name required'}, 400);
      if(!expName) return jsonResp({error:'expect_name required(取り違え防止のため必須)'}, 400);
      const curR = parseRates(await getRateRowsCached(true));
      const tgtR = curR.find((r:any)=>r.row_number===Number(row_number));
      if(!tgtR) return jsonResp({error:'対象の行が見つかりません', code:'ROW_NOT_FOUND'}, 404);
      if(tgtR.name!==expName){
        return jsonResp({error:`対象が一致しません(指定:「${expName}」/ 実際の${row_number}行目:「${tgtR.name}」)`, code:'NAME_MISMATCH'}, 409);
      }
      if(curR.some((r:any)=>r.row_number!==Number(row_number) && r.name===newName)){
        return jsonResp({error:`「${newName}」は既に別の行にあります(確定明細は氏名で一意のため重複させない)`, code:'DUP_NAME'}, 409);
      }
      const tkR = await getAccessToken();
      const putR = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${tkR}`,'Content-Type':'application/json'},body:JSON.stringify({values:[[newName]]})});
      if(!putR.ok) return jsonResp({error:'sheet update failed: '+putR.status+' '+(await putR.text()).slice(0,200)}, 500);
      await invalidateRateCache();
      const aliased = await registerRename(expName, newName, '単価マスタの改名(新聞ツール)', 'rename_rate');
      return jsonResp({success:true, row_number:Number(row_number), from:expName, to:newName, aliased});
    }

    // ---- 以下はトークン必須 ----
    const claims = await verifyToken(auth_token);
    if (!claims) return authErr();
    const admin = isAdmin(claims);
    const corpSub = isCorpSub(claims);
    const corpOwner = isCorpOwner(claims);
    // 金額表示ON の配下スタッフは、オーナー同様に同company全員を扱える
    const corpSubManager = corpSub && claims.company_shows_money === true;
    const callerName = claims.name || '';
    const callerCompany = claims.company || '';

    // ---- 法人新規登録(2026-10-19) ----
    // 法人名は会計マスタの名前からしか選べない。無い会社はここから会計マスタへ「仮登録」する。
    // 実体は NexPort 側の list-invoice-companies(register)。新聞のログインはここで確かめ、合言葉付きで代理送信する。
    if (action === 'register_company') {
      if (!admin) return jsonResp({ error: '法人の新規登録は管理者のみです' }, 403);
      const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/list-invoice-companies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': SYNC_SECRET },
        body: JSON.stringify({ action: 'register', name: body.name, tool: 'shift', requested_by: callerName || '新聞管理者' }),
      });
      const j = await r.json().catch(() => ({ error: '応答を読めませんでした' }));
      return jsonResp(j, r.status);
    }

    // ---- コースのマイマップURL (2026-10-15) ----
    // それまで画面が anon キーで course_mymaps を直接読み書きしており、ログインなしで誰でも書き換えられた。
    // 読むのはログインした人全員、保存・削除は管理者だけ(管理画面からしか使わない)。表は authenticated のみに絞った。
    if (action === 'mymaps_list' || action === 'mymaps_save' || action === 'mymaps_delete') {
      const sbm = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      if (action === 'mymaps_list') {
        const { data, error } = await sbm.from('course_mymaps').select('course_name,type,mymap_url');
        if (error) return jsonResp({ error: error.message }, 500);
        return jsonResp({ success: true, rows: data ?? [] });
      }
      if (!admin) return jsonResp({ error: '管理者のみ変更できます' }, 403);
      const cn = String(body.course_name || '').trim(), tp = String(body.type || '').trim();
      if (!cn || !tp) return jsonResp({ error: 'course_name / type が必要です' }, 400);
      if (action === 'mymaps_save') {
        const url = String(body.mymap_url || '').trim();
        if (!/^https:\/\//.test(url)) return jsonResp({ error: 'URLは https:// で始めてください' }, 400);
        const { error } = await sbm.from('course_mymaps').upsert({ course_name: cn, type: tp, mymap_url: url, updated_at: new Date().toISOString() }, { onConflict: 'course_name,type' });
        if (error) return jsonResp({ error: error.message }, 500);
        return jsonResp({ success: true });
      }
      const { error } = await sbm.from('course_mymaps').delete().eq('course_name', cn).eq('type', tp);
      if (error) return jsonResp({ error: error.message }, 500);
      return jsonResp({ success: true });
    }

    const sheetsToken = await getAccessToken();
    await ensureSheets(sheetsToken);

    // 法人オーナーが操作できる配下スタッフ名集合 (キャッシュ的に1リクエスト内で1回だけ取得)
    let scopeNames: Set<string> | null = null;
    async function getScopeNames(): Promise<Set<string>> {
      if (scopeNames) return scopeNames;
      const s = new Set<string>([callerName]);
      if ((corpOwner || corpSubManager) && callerCompany) {
        const subs = await fetchCompanyNames(sheetsToken, callerCompany);
        subs.forEach(n => s.add(n));
      }
      scopeNames = s;
      return s;
    }

    if(action==='get_staff_names'){
      if (admin) {
        const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}/values/${encodeURIComponent(ROSTER_SHEET_NAME)}!C2:C500`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        const names=[...new Set((await sheetVals(resp)).map((r:string[])=>(r[0]||'').trim()).filter(Boolean))];
        return jsonResp({names});
      }
      // 非admin: 自分 (+ owner なら配下) のみ
      const scope = await getScopeNames();
      return jsonResp({ names: [...scope] });
    }
    if(action==='get_roster'){
      // 人員名簿の全行を返す (loadLiveStaff/営業所判定用)。列: A=営業所 B=契約 C=氏名 D=電話 E-K=朝 L-R=夕
      if(!admin) return forbid();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ROSTER_SHEET_ID}/values/${encodeURIComponent(ROSTER_SHEET_NAME)}!A1:Z500`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rows=await sheetVals(resp);
      // D列(電話)の0落ちを直してから返す(シートは書き換えない)。1行目は見出し。
      for(let i=1;i<rows.length;i++){const r=rows[i];if(r&&String(r[3]??'').trim())r[3]=fixJpPhone(r[3]);}
      // D列(電話)が空の行は中央人材マスタ(staff_master)から氏名で補完する。
      // 人員名簿シートだけを電話の情報源にしていたため、NexPort・staff_master に電話があっても
      // 「電話番号未登録」となり、支払明細の確定保存やビューア照合が通らなかった(上田雪枝で発生)。
      // シートは書き換えず、返す値だけを補う(正=staff_master、シートは人が見るためのコピー)。
      const pf=await fillRosterPhones(rows);
      return jsonResp({rows, phone_filled: pf.filled, phone_ambiguous: pf.ambiguous, master_phones: pf.map});
    }
    if(action==='get_special_rates'){
      if(!admin) return forbid();
      // 特別日当は複数画面から何度も読まれ、Sheets の「1分あたり読取上限」に当たりやすい。
      // 実際に 429 が空配列に化けて「登録0件」に見える事象が起きたため、
      // ①短期キャッシュで読取回数を減らし ②429 はリトライ ③それでも駄目なら 502 で理由を返す。
      let raw: any[];
      try{
        raw = await getSpecialRowsCached();
      }catch(e){
        return jsonResp({error:`特別日当シートの読み取りに失敗しました: ${String((e as any)?.message||e).slice(0,300)}`, sheet:SPECIAL_SHEET_NAME}, 502);
      }
      const records=raw.map((r:string[],i:number)=>({row_number:i+2,timestamp:r[0]||'',date:r[1]||'',name:r[2]||'',amount:r[3]||'',reason:r[4]||'',applicant:r[5]||'',category:r[6]||'',type:r[7]||'',office:r[8]||'',modified_at:r[10]||''})).filter((r:any)=>r.date&&r.name);
      return jsonResp({records});
    }
    if(action==='save_special_rate'){
      // 特別単価(日当/日当+)を管理画面から手入力。Googleフォーム回答シートへ直接 append/PUT。
      // 🚨 A列(入力日)はサーバーが決め、編集では絶対に書き換えない。
      //    以前は編集のたびに A列を「今」で上書きしていたため、支払確定より前に入れた日当が
      //    確定後に入れたように見え、確定後の入力かどうかを後から判断できなかった(2026-10 大塚孝秀)。
      //    編集した日時は K列(変更日)に残す。I列(営業所)も画面から送られないので元の値を保つ。
      if(!admin) return forbid();
      if(!record?.date||!record?.name) return jsonResp({error:'date and name required'},400);
      const nowJst=new Date(Date.now()+9*3600*1000).toISOString().slice(0,19).replace('T',' ').replace(/-/g,'/');
      const spUrl=(a1:string)=>`https://sheets.googleapis.com/v4/spreadsheets/${SPECIAL_SHEET_ID}/values/${encodeURIComponent(`${SPECIAL_SHEET_NAME}!${a1}`)}`;
      const putCells=async(a1:string,values:any[][])=>{
        const r=await fetch(`${spUrl(a1)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values})});
        if(!r.ok) throw new Error(`特別日当シートへの書き込みに失敗しました(${r.status}): ${(await r.text()).slice(0,200)}`);
      };
      if(row_number){
        const cur=await fetch(spUrl(`A${row_number}:I${row_number}`),{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        if(!cur.ok) return jsonResp({error:`特別日当シートの読み取りに失敗しました(${cur.status})`},502);
        const old:string[]=((await cur.json()).values||[])[0]||[];
        if(!old[1]&&!old[2]) return jsonResp({error:'編集する行が見つかりません(削除された可能性があります)。一覧を読み直してください。'},409);
        const row=[record.date||'', record.name||'', record.amount||'', record.reason||'', record.applicant||old[5]||'管理画面', record.category||'', record.type||'日当', record.office ?? old[8] ?? ''];
        await putCells(`B${row_number}:I${row_number}`,[row]);   // A列(入力日)には触らない
        await putCells(`K${row_number}`,[[nowJst]]);             // 変更日
        await putCells('K1',[['変更日']]);
      }else{
        const row=[nowJst, record.date||'', record.name||'', record.amount||'', record.reason||'', record.applicant||'管理画面', record.category||'', record.type||'日当', record.office||''];
        const r=await fetch(`${spUrl('A1:I1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
        if(!r.ok) return jsonResp({error:`特別日当シートへの追加に失敗しました(${r.status})`},502);
      }
      await invalidateSpecialCache(); // 保存したら次の取得は必ずシートから
      return jsonResp({success:true});
    }
    if(action==='delete_special_rate'){
      if(!admin) return forbid();
      if(!row_number) return jsonResp({error:'row_number required'},400);
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPECIAL_SHEET_ID}/values/${encodeURIComponent(SPECIAL_SHEET_NAME)}!A${row_number}:I${row_number}:clear`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`}});
      await invalidateSpecialCache(); // 削除したら次の取得は必ずシートから
      return jsonResp({success:true});
    }
    if(action==='get_rates'){
      // Sheets の一時失敗(429/5xx)で単価が"静かに0件"になると、自動確定が全断する。
      // → 軽リトライ付きで取得し、それでも駄目なら 503 を返して呼び出し側に失敗を伝える。
      let rateRows: any[];
      try{ rateRows = await fetchSheetValuesWithRetry('単価マスタ!2:200', async()=>sheetsToken); }
      catch(e){ return jsonResp({error:'単価マスタの取得に失敗しました(Sheets一時エラー)。少し待って再実行してください。', detail:String((e as any)?.message||e)}, 503); }
      let all: any[];
      try{ all = await attachSiteRates(parseRates(rateRows)); }
      catch(e){ return jsonResp({error:'拠点別の単価の取得に失敗しました。少し待って再実行してください。', detail:String((e as any)?.message||e)}, 503); }
      if (admin) return jsonResp({rates: all});
      // staff/owner: scopeNames に含まれる行のみ。corp-sub は金額系も剥がす (自社オーナーが show_money ON なら剥がさない=ライブ判定)
      const csm = !corpSub || memberShowsMoney(all, callerName);
      const scope = await getScopeNames();
      const out = all.filter((r:any)=>scope.has(r.name)).map((r:any)=> (corpSub && !csm) ? stripPrices(stripStaffPrivate(r)) : stripStaffPrivate(r));
      return jsonResp({rates: out, company_shows_money: csm});
    }
    // ── 拠点別の単価の保存・削除(管理者のみ) ──
    if(action==='save_site_rate'){
      if(!admin) return forbid();
      const s = body.site_rate || {};
      const staff = String(s.staff_name||'').trim();
      if(!staff) return jsonResp({error:'staff_name required'},400);
      if(!SITE_AREAS.includes(s.area)) return jsonResp({error:'拠点が正しくありません'},400);
      if(!/^\d{4}-\d{2}$/.test(String(s.effective_from||''))) return jsonResp({error:'「何月分から」を YYYY-MM で入れてください'},400);
      const row: any = { staff_name: staff, area: s.area, effective_from: s.effective_from, note: s.note ?? null, updated_by: callerName || 'admin', updated_at: new Date().toISOString() };
      for (const f of SITE_RATE_FIELDS) row[f] = String(s[f] ?? '').replace(/[,，¥￥\s]/g, '');
      if (!['固定','個建','個数'].includes(row.calc_type)) row.calc_type = '固定';
      if (!['','固定','個建','個数'].includes(row.calc_type_pm)) row.calc_type_pm = '';
      const SB_URL=Deno.env.get('SUPABASE_URL')||'', SRK=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
      const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
      let res: Response;
      if (s.id) res = await fetch(`${SB_URL}/rest/v1/shift_site_rates?id=eq.${encodeURIComponent(s.id)}`, { method: 'PATCH', headers: H, body: JSON.stringify(row) });
      else res = await fetch(`${SB_URL}/rest/v1/shift_site_rates?on_conflict=staff_name,area,effective_from`, { method: 'POST', headers: { ...H, Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify(row) });
      if (!res.ok) return jsonResp({error:'保存できませんでした: '+(await res.text()).slice(0,300)},500);
      return jsonResp({success:true, site_rate:(await res.json())[0]});
    }
    if(action==='delete_site_rate'){
      if(!admin) return forbid();
      const id = String(body.id||'');
      if(!id) return jsonResp({error:'id required'},400);
      const SB_URL=Deno.env.get('SUPABASE_URL')||'', SRK=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
      const res = await fetch(`${SB_URL}/rest/v1/shift_site_rates?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      if (!res.ok) return jsonResp({error:'削除できませんでした: '+(await res.text()).slice(0,300)},500);
      return jsonResp({success:true});
    }
    if(action==='get_name_aliases'){
      if(!admin) return forbid();
      const r = await sbRest('shift_name_aliases?select=alias_key,alias,staff_name,note,created_by,created_at&order=created_at.desc');
      if(!r.ok) return jsonResp({error:'取得失敗: '+(await r.text()).slice(0,200)}, 500);
      return jsonResp({aliases: await r.json()});
    }
    if(action==='save_name_alias'){
      if(!admin) return forbid();
      const al = String(body.alias ?? '').trim(), to = String(body.staff_name ?? '').trim();
      if(!al || !to) return jsonResp({error:'alias と staff_name が必要です'}, 400);
      if(aliasKey(al) === aliasKey(to)) return jsonResp({error:'同じ名前です'}, 400);
      // 別名の先は単価マスタにある名前だけ(打ち間違いの先に寄せない)
      const rates = parseRates(await getRateRowsCached(false));
      if(!rates.some((x:any)=>aliasKey(x.name)===aliasKey(to))) return jsonResp({error:`「${to}」は単価マスタにありません`}, 400);
      if(rates.some((x:any)=>aliasKey(x.name)===aliasKey(al))) return jsonResp({error:`「${al}」は単価マスタにある名前なので別名にできません`}, 400);
      const w = await sbRest('shift_name_aliases?on_conflict=alias_key', { method:'POST', headers:{ 'Prefer':'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ alias_key: aliasKey(al), alias: al, staff_name: to, note: String(body.note ?? '').slice(0,200), created_by: String(callerName || 'admin') }]) });
      if(!w.ok) return jsonResp({error:'保存失敗: '+(await w.text()).slice(0,200)}, 500);
      return jsonResp({success:true});
    }
    if(action==='delete_name_alias'){
      if(!admin) return forbid();
      const k = aliasKey(body.alias);
      if(!k) return jsonResp({error:'alias が必要です'}, 400);
      const d = await sbRest(`shift_name_aliases?alias_key=eq.${encodeURIComponent(k)}`, { method:'DELETE', headers:{ 'Prefer':'return=minimal' } });
      if(!d.ok) return jsonResp({error:'削除失敗: '+(await d.text()).slice(0,200)}, 500);
      return jsonResp({success:true});
    }
    if(action==='save_rate'){
      if(!admin) return forbid();
      if(!record?.name) return jsonResp({error:'name required'}, 400);
      // 所属会社は会計マスタにある名前だけ(2026-10-19・表記ゆれ防止)。画面は選択式だが、ここでも確かめる。
      // 既存行の会社欄が旧表記のまま変わっていないときは通す(他の項目だけ直す保存を止めない)。
      { const co=String(record.company||'').trim();
        if(co){
          const SB_URL=Deno.env.get('SUPABASE_URL')||'', SRK=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
          const pr=await fetch(`${SB_URL}/rest/v1/acc_invoice_partners?select=name`,{headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`}});
          const names=new Set(((pr.ok?await pr.json():[]) as any[]).map((r:any)=>String(r.name||'').trim()));
          if(pr.ok && !names.has(co)){
            let unchanged=false;
            if(row_number){ const cur=parseRates(await sheetVals(await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A${row_number}:X${row_number}`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}))); unchanged=String(cur[0]?.company||'').trim()===co; }
            if(!unchanged) return jsonResp({error:`所属会社「${co}」は会計マスタにありません。一覧から選ぶか「＋法人新規登録」で登録してください`},400);
          }
        }
      }
      // 名前が変わる保存なら、旧名を別名に登録する(シフト表に旧名のまま入っている日を取りこぼさない)
      let oldNameForAlias='';
      if(row_number){ try{ const cur0=parseRates(await sheetVals(await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A${row_number}:X${row_number}`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}))); oldNameForAlias=String(cur0[0]?.name||'').trim(); }catch(_){} }
      const row=[record.name,record.am_weekday||'',record.am_weekend||'',record.pm_weekday||'',record.pm_weekend||'',record.warehouse_am||'',record.warehouse_pm||'',record.calc_type||'固定',record.unit_price||'',record.login_id||'',record.login_pw||'',record.biz_type||'',record.company||'',record.calc_type_pm||'固定',record.unit_price_pm||'',record.am_sunday||'',record.pm_sunday||'',record.permissions||'',record.kw_am_daily||'',record.kw_pattern||'',record.monthly_salary||'',record.invoice_number||'',record.rate_effective_from||'',record.planner_allowance||''];
      if(row_number){await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A${row_number}:X${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});}
      else{await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A1:X1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});}
      await invalidateRateCache();
      const aliased = oldNameForAlias ? await registerRename(oldNameForAlias, String(record.name).trim(), '単価マスタの改名(スタッフ管理で保存)', 'save_rate') : false;
      return jsonResp({success:true, aliased});
    }
    if(action==='change_password'){
      // 本人のログインパスワード変更 (現在PWをサーバ側で照合)。adminは login_id 指定で任意ユーザー可。
      const oldPw = String(body.old_pw ?? '').trim();
      const newPw = String(body.new_pw ?? '').trim();
      if(newPw.length < 3) return jsonResp({error:'新しいパスワードは3文字以上にしてください'}, 400);
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rates = parseRates(await sheetVals(resp));
      let target:any;
      if(admin && body.login_id){ target = rates.find((r:any)=>(r.login_id||'').trim()===String(body.login_id).trim()); }
      else { target = rates.find((r:any)=>r.name===callerName); }
      if(!target) return jsonResp({error:'ユーザーが見つかりません'}, 404);
      if(!admin){
        if((target.login_pw||'').trim() !== oldPw) return jsonResp({error:'現在のパスワードが正しくありません', code:'BAD_OLD_PW'}, 403);
      }
      // login_pw = K列(index10)。該当行のみ更新。
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!K${target.row_number}?valueInputOption=USER_ENTERED`,{
        method:'PUT', headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},
        body: JSON.stringify({ values:[[newPw]] }),
      });
      await invalidateRateCache();
      return jsonResp({success:true});
    }
    if(action==='delete_rate'){
      if(!admin) return forbid();
      if(!row_number) return jsonResp({error:'row_number required'}, 400);
      const rowIdx=Number(row_number)-1;
      if(rowIdx<1) return jsonResp({error:'cannot delete header'}, 400);
      // 行番号は位置ベースで、行を1つ消すと以降が繰り上がる。古い一覧から消すと別人が消える。
      // 削除直前にシートを読み直し、対象行の実在と氏名の一致を確認する(owner_delete_member と同じ作法)。
      const curDel = parseRates(await sheetVals(await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}), '単価マスタ'));
      const tgtDel = curDel.find((r:any)=>r.row_number===Number(row_number));
      if(!tgtDel) return jsonResp({error:'削除対象の行が見つかりません。一覧を再読み込みしてください。', code:'ROW_NOT_FOUND'}, 404);
      const expName=String(expect_name||'').trim();
      if(expName && tgtDel.name!==expName){
        return jsonResp({error:`削除対象が一致しません(指定:「${expName}」/ 実際の${row_number}行目:「${tgtDel.name}」)。一覧を再読み込みしてから操作してください。`, code:'NAME_MISMATCH'}, 409);
      }
      const delResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{deleteDimension:{range:{sheetId:RATE_SHEET_ID,dimension:'ROWS',startIndex:rowIdx,endIndex:rowIdx+1}}}]})});
      if(!delResp.ok){
        const errText=await delResp.text();
        return jsonResp({error:'deleteDimension failed: '+delResp.status+' '+errText.slice(0,200)}, 500);
      }
      await invalidateRateCache();
      return jsonResp({success:true, deleted_name:tgtDel.name});
    }
    // ── 法人オーナー: 自社メンバーのみ管理 (単価は保全=編集不可, 会社/区分は固定) ──
    if(action==='owner_save_member'){
      if(!corpOwner) return forbid();
      if(!callerCompany) return forbid('会社情報がありません');
      if(!record?.name) return jsonResp({error:'name required'}, 400);
      const cur = parseRates(await sheetVals(await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}), '単価マスタ'));
      let base: any = {};
      if(row_number){
        base = cur.find((r:any)=>r.row_number===Number(row_number));
        if(!base) return jsonResp({error:'row not found'}, 404);
        if(!sameCo(base.company,callerCompany)) return forbid('自社メンバーのみ編集できます');
      }
      const isSelf = row_number ? (base.name===callerName) : false; // 新規は常に配下扱い
      // 価格系は base から保全 (オーナーは編集不可)。 オーナーが触れるのは 氏名/ログイン/show_money のみ
      const m: any = { ...base };
      m.name = record.name;
      m.login_id = record.login_id ? record.login_id : (base.login_id||''); // 空欄は現状維持
      m.login_pw = record.login_pw ? record.login_pw : (base.login_pw||''); // 空欄は現状維持(編集時PW消さない)
      m.biz_type = '法人';
      // 会社欄は単価マスタ上の表記(正式名へ置き換え済み)を優先。トークンの旧表記で書き戻さない。
      m.company = (base.company && sameCo(base.company, callerCompany)) ? base.company : ((cur as any[]).find((r:any)=>sameCo(r.company, callerCompany))?.company || callerCompany);
      // show_money: record で明示されればそれ、無ければ現状(base)維持 (氏名編集で消さない)
      const baseShow = (base.permissions||'').split(',').includes('show_money');
      const wantShow = (record.show_money !== undefined) ? !!record.show_money : baseShow;
      if(isSelf){ const p=['owner']; if(wantShow) p.push('show_money'); m.permissions=p.join(','); }
      else { m.permissions = wantShow ? 'show_money' : ''; } // 配下: 本人に金額表示するかを個別保存
      const row=[m.name,m.am_weekday||'',m.am_weekend||'',m.pm_weekday||'',m.pm_weekend||'',m.warehouse_am||'',m.warehouse_pm||'',m.calc_type||'固定',m.unit_price||'',m.login_id||'',m.login_pw||'',m.biz_type||'',m.company||'',m.calc_type_pm||'固定',m.unit_price_pm||'',m.am_sunday||'',m.pm_sunday||'',m.permissions||'',m.kw_am_daily||'',m.kw_pattern||'',m.monthly_salary||'',m.invoice_number||''];
      if(row_number){await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A${row_number}:V${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});}
      else{await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A1:V1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});}
      await invalidateRateCache();
      return jsonResp({success:true});
    }
    if(action==='owner_delete_member'){
      if(!corpOwner) return forbid();
      if(!row_number) return jsonResp({error:'row_number required'}, 400);
      const cur = parseRates(await sheetVals(await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}), '単価マスタ'));
      const tgt = cur.find((r:any)=>r.row_number===Number(row_number));
      if(!tgt) return jsonResp({error:'row not found'}, 404);
      if(!sameCo(tgt.company,callerCompany)) return forbid('自社メンバーのみ削除できます');
      if(tgt.name===callerName) return forbid('自分自身は削除できません');
      const rowIdx=Number(row_number)-1;
      if(rowIdx<1) return jsonResp({error:'cannot delete header'}, 400);
      const delResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{deleteDimension:{range:{sheetId:RATE_SHEET_ID,dimension:'ROWS',startIndex:rowIdx,endIndex:rowIdx+1}}}]})});
      if(!delResp.ok){ return jsonResp({error:'delete failed: '+delResp.status+' '+(await delResp.text()).slice(0,200)}, 500); }
      await invalidateRateCache();
      return jsonResp({success:true});
    }
    if(action==='list_work'){
      const all = parseWork(await getWorkRowsCached());
      if (admin) return jsonResp({records: all});
      // corp-sub の金額表示はライブ判定 (自社オーナーの show_money を都度参照)
      let csm = true;
      if (corpSub) {
        const rr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!2:200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        csm = memberShowsMoney(parseRates(await sheetVals(rr)), callerName);
      }
      const scope = await getScopeNames();
      const mine = all.filter((r:any)=>scope.has(r.staff)).map((r:any)=> (corpSub && !csm) ? { ...r, unit_price:'', amount:'' } : r);
      return jsonResp({records: mine, company_shows_money: csm});
    }
    if(action==='add_work'){
      if(!record) return jsonResp({error:'record required'}, 400);
      if(!admin){
        const scope = await getScopeNames();
        if(!scope.has(record.staff||'')) return forbid('権限のないスタッフの稼働は追加できません');
      }
      // 当日分の解禁時刻 (JST): 朝刊系=4:00 / 夕刊系=14:00 より前は登録不可
      {
        const nowJst=new Date(Date.now()+9*3600*1000);
        const jstToday=`${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth()+1).padStart(2,'0')}-${String(nowJst.getUTCDate()).padStart(2,'0')}`;
        const recDate=String(record.date||'').replace(/\//g,'-');
        const isPm=String(record.category||'').includes('夕')||String(record.category||'').includes('競馬');
        const minH=isPm?14:4;
        if(recDate===jstToday && nowJst.getUTCHours()<minH){
          return jsonResp({error:`当日の${isPm?'夕刊':'朝刊'}は${minH}:00以降に登録できます（現在 ${String(nowJst.getUTCHours()).padStart(2,'0')}時台/JST）`, code:'TOO_EARLY'},403);
        }
      }
      // 二重計上防止: 同 スタッフ+日付+区分+コース が既にあれば拒否
      {
        const exResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        const exWork=parseWork(await sheetVals(exResp));
        const key=workDupKey(record);
        const dup=exWork.find((w:any)=>workDupKey(w)===key);
        if(dup) return jsonResp({error:`二重計上: 同じ稼働(${dup.date} ${dup.staff} / ${dup.category} / ${dup.course||'コース無し'})が既に登録されています`, code:'DUPLICATE'}, 409);
      }
      const row=[record.date||'',record.staff||'',record.course||'',record.category||'',record.start_time||'',record.end_time||'',record.quantity||'',record.unit_price||'',record.amount||'',''];
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A1:J1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      await invalidateWorkCache(); // 追加したので次の一覧は必ずシートから
      return jsonResp({success:true});
    }
    if(action==='update_work'){
      if(!record||!row_number) return jsonResp({error:'record and row_number required'}, 400);
      // 行のオーナー確認 (staff/owner のみ・admin はスキップ)
      if(!admin){
        const scope = await getScopeNames();
        const chk=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A${row_number}:J${row_number}`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        const cv=(await chk.json()).values?.[0]||[];
        const existingStaff = cv[1] || '';
        if(!scope.has(existingStaff)) return forbid('権限のないスタッフの稼働は編集できません');
        if(cv[9]) return jsonResp({error:'確定済みの記録は編集できません'}, 403);
        // 書き換え後の staff も scope 内に限る (オーナーが配下↔配下/自分↔配下 への移動はOK)
        if(record.staff && !scope.has(record.staff)) return forbid('権限のないスタッフへ変更できません');
      }
      // 二重計上防止: 変更後の内容が「別の行」と重複するなら拒否 (自分の行への上書きはOK)
      {
        const exResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        const exWork=parseWork(await sheetVals(exResp));
        const key=workDupKey({staff:record.staff||callerName,date:record.date,category:record.category,course:record.course});
        const dup=exWork.find((w:any)=>w.row_number!==Number(row_number)&&workDupKey(w)===key);
        if(dup) return jsonResp({error:`二重計上: 同じ稼働(${dup.date} ${dup.staff} / ${dup.category} / ${dup.course||'コース無し'})が既に登録されています`, code:'DUPLICATE'}, 409);
      }
      const row=[record.date||'',record.staff||callerName,record.course||'',record.category||'',record.start_time||'',record.end_time||'',record.quantity||'',record.unit_price||'',record.amount||''];
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A${row_number}:I${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      await invalidateWorkCache(); // 変更したので次の一覧は必ずシートから
      return jsonResp({success:true});
    }
    if(action==='delete_work'){
      if(!row_number) return jsonResp({error:'row_number required'}, 400);
      if(!admin){
        const scope = await getScopeNames();
        const chk=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A${row_number}:J${row_number}`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        const cv=(await chk.json()).values?.[0]||[];
        const existingStaff = cv[1] || '';
        if(!scope.has(existingStaff)) return forbid('権限のないスタッフの稼働は削除できません');
        if(cv[9]) return jsonResp({error:'確定済みの記録は削除できません'}, 403);
      }
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A${row_number}:J${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[Array(10).fill('')]})});
      await invalidateWorkCache(); // 変更したので次の一覧は必ずシートから
      return jsonResp({success:true});
    }
    if(action==='batch_recalc_amounts'){
      // updates=[{row_number, unit_price, amount}] を 稼働記録 H:I へ一括反映。
      // 確定済み行・スコープ外行はスキップ。クライアントが単価マスタで再計算した値を渡す。
      if(!Array.isArray(row_numbers) && !Array.isArray(updates)) return jsonResp({error:'updates required'},400);
      const ups = (updates || []) as any[];
      if(!ups.length) return jsonResp({success:true, updated:0, skipped:0});
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const all = parseWork(await sheetVals(resp));
      const byRow = new Map<number, any>(all.map((w:any)=>[w.row_number, w]));
      let scope: Set<string> | null = null;
      if(!admin) scope = await getScopeNames();
      const data:any[] = []; let skipped = 0;
      for(const u of ups){
        const rn = Number(u.row_number);
        const w = byRow.get(rn);
        if(!w){ skipped++; continue; }
        if(!admin && scope && !scope.has(w.staff)){ skipped++; continue; }
        if((w.confirmed||'').toString().trim()){ skipped++; continue; } // 確定済みは触らない
        data.push({ range: `'稼働記録'!H${rn}:I${rn}`, values: [[ String(u.unit_price ?? ''), String(u.amount ?? '') ]] });
      }
      if(data.length){
        await invalidateWorkCache(); // 稼働記録を書き換えるので一覧キャッシュを破棄
        const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{
          method:'POST', headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},
          body: JSON.stringify({ valueInputOption:'USER_ENTERED', data }),
        });
        if(!up.ok){ const t=await up.text(); return jsonResp({error:'batch update failed: '+up.status+' '+t.slice(0,300)},500); }
      }
      return jsonResp({success:true, updated:data.length, skipped});
    }
    if(action==='confirm_records'){
      if(!admin) return forbid();
      if(!row_numbers||!row_numbers.length) return jsonResp({error:'row_numbers required'}, 400);
      const data:any[]=[];const today=new Date().toISOString().split('T')[0];
      // batchUpdate の data[].range はボディ内A1表記。URLではないので percent-encode してはいけない
      // (エンコードすると存在しないシート名扱いで400→黙って確定が効かなくなる)。素の 'シート名'!セル で渡す。
      for(const rn of row_numbers){data.push({range:`'稼働記録'!J${rn}`,values:[[today]]});}
      const cfResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data})});
      if(!cfResp.ok){ const t=await cfResp.text(); return jsonResp({error:'確定の書き込みに失敗しました: '+cfResp.status+' '+t.slice(0,200)},500); }
      await invalidateWorkCache();
      return jsonResp({success:true,confirmed:row_numbers.length});
    }
    if(action==='unconfirm_records'){
      if(!admin) return forbid();
      if(!row_numbers||!row_numbers.length) return jsonResp({error:'row_numbers required'}, 400);
      const data:any[]=[];
      for(const rn of row_numbers){data.push({range:`'稼働記録'!J${rn}`,values:[['']]});}
      const ucResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data})});
      if(!ucResp.ok){ const t=await ucResp.text(); return jsonResp({error:'確定解除の書き込みに失敗しました: '+ucResp.status+' '+t.slice(0,200)},500); }
      await invalidateWorkCache();
      return jsonResp({success:true,unconfirmed:row_numbers.length});
    }
    if(action==='list_measure'){
      // ★範囲を A2:H10000 で切っていたため、シートが1万行を超えた 2026-09-13 以降の
      //   測定が管理画面に1件も出なくなっていた(追記はされているので消えてはいない)。
      //   行数を決め打ちしない A2:H にする。
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A2:H`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rows=(await sheetVals(resp)).filter((r:string[])=>r[0]||r[1]);
      const records=rows.map((r:string[])=>({date:r[0]||'',course:r[1]||'',type:r[2]||'',start_time:r[3]||'',end_time:r[4]||'',shop_name:r[5]||'',arrival_time:r[6]||'',staff:r[7]||''}));
      return jsonResp({records});
    }
    if(action==='save_measure'){
      if(!measure_data) return jsonResp({error:'measure_data required'}, 400);
      const{date,course,type,start_time,end_time,staff,shops}=measure_data;
      // staff は自分の名前のみ
      const staffName = admin ? (staff || '') : callerName;
      const rows=(shops||[]).map((s:any)=>[date||'',course||'',type||'',start_time||'',end_time||'',s.name||'',s.time||'',staffName]);
      // 店舗0件は通常ありえない(誤って1ブロック消すのを防ぐ)。
      // 管理者が clear_block:true を明示した時だけ、そのブロックの行を空にする。
      if(!rows.length && !(admin && measure_data.clear_block === true)) return jsonResp({success:true,saved:0});
      // ★1測定=1ブロック。
      //   従来は「📤 途中送信」が毎回全店舗を追記していたため、1日1コースで
      //   48店→192行(4回送信)のように増殖し、測定記録シートが1万行を超えた。
      //   replace_block 指定時は 日付+コース+区分+担当者 が同じ既存行を
      //   その場で上書きし、余りは空にする(他人・他日・他コースの行は触らない)。
      //   キーのどれかが空だと別人・別日の行まで掴んでしまうため、揃っている時だけ上書きする。
      const wantReplace = (measure_data.replace_block === true || (admin && measure_data.clear_block === true)) && !!date && !!course && !!type && !!staffName;
      let replaced = 0;
      if(wantReplace){
        const exResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A2:H`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        const exRows=await sheetVals(exResp,'測定記録');
        const same=(v:any,w:any)=>String(v||'').trim()===String(w||'').trim();
        const hitRowNumbers:number[]=[];
        exRows.forEach((r:string[],i:number)=>{
          if(same(r[0],date)&&same(r[1],course)&&same(r[2],type)&&same(r[7],staffName))hitRowNumbers.push(i+2);
        });
        const data:any[]=[];
        const n=Math.min(hitRowNumbers.length,rows.length);
        for(let i=0;i<n;i++)data.push({range:`'${MEASURE_SHEET}'!A${hitRowNumbers[i]}:H${hitRowNumbers[i]}`,values:[rows[i]]});
        // 既存が多い(店舗が減った)場合は余剰行を空にする
        for(let i=n;i<hitRowNumbers.length;i++)data.push({range:`'${MEASURE_SHEET}'!A${hitRowNumbers[i]}:H${hitRowNumbers[i]}`,values:[['','','','','','','','']]});
        if(data.length){
          const upd=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data})});
          if(!upd.ok){const t=await upd.text();return jsonResp({error:'測定記録の更新に失敗しました: '+upd.status+' '+t.slice(0,200)},500);}
        }
        replaced=n;
        rows.splice(0,n);// 上書きできた分は追記しない
      }
      if(rows.length){
        const ap=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A1:H1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:rows})});
        if(!ap.ok){const t=await ap.text();return jsonResp({error:'測定記録の保存に失敗しました: '+ap.status+' '+t.slice(0,200)},500);}
      }
      return jsonResp({success:true,saved:replaced+rows.length,replaced,appended:rows.length});
    }
    // ── 請求条件(休刊日/朝刊なし/夕刊なし/同梱有無/競馬日 など) ───────────────
    // 画面(localStorage)の billConditions を DB(bill_conditions)へ同期する。
    // サーバ側の自動確定(finalize-shift)はこのテーブルしか見ないため、同期されていないと
    // 休刊日などが無視された金額で確定されてしまう。月ごとに1行(月キー=YYYY-MM)。
    if(action==='save_bill_conditions'){
      if(!admin) return forbid();
      if(!bill_conditions || typeof bill_conditions !== 'object') return jsonResp({error:'bill_conditions required'}, 400);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'SUPABASE_URL / SERVICE_ROLE_KEY 未設定'}, 500);
      const now = new Date().toISOString();
      const rows = Object.keys(bill_conditions)
        .filter((m)=>/^\d{4}-\d{2}$/.test(m) && bill_conditions[m] && typeof bill_conditions[m]==='object')
        .map((m)=>({ month_val: m, conditions: bill_conditions[m], updated_at: now }));
      if(!rows.length) return jsonResp({error:'保存できる月がありません(キーは YYYY-MM 形式)'}, 400);
      const r = await fetch(`${SB_URL}/rest/v1/bill_conditions`, {
        method: 'POST',
        headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      if(!r.ok) return jsonResp({error:'保存失敗: '+(await r.text()).slice(0,200)}, 500);
      return jsonResp({success:true, saved: rows.length, months: rows.map((x)=>x.month_val).sort()});
    }
    if(action==='get_bill_conditions'){
      if(!admin) return forbid();
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'SUPABASE_URL / SERVICE_ROLE_KEY 未設定'}, 500);
      const q = year_month ? `&month_val=eq.${encodeURIComponent(year_month)}` : '';
      const r = await fetch(`${SB_URL}/rest/v1/bill_conditions?select=month_val,conditions,updated_at${q}`, { headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } });
      if(!r.ok) return jsonResp({error:'取得失敗: '+(await r.text()).slice(0,200)}, 500);
      const arr = await r.json();
      const out: any = {};
      (arr||[]).forEach((x:any)=>{ out[x.month_val] = x.conditions || {}; });
      return jsonResp({bill_conditions: out, months: Object.keys(out).sort()});
    }
    if(action==='get_bill_prices'){
      if(!admin) return forbid();
      // 🚨 2026-09-10: ここだけリトライも resp.ok チェックも無く、Sheetsの読取上限(429)等で
      //    失敗すると values が無く row=[] → 全単価が黙って0になっていた。
      //    45コース一括作成はSheetsを大量に読むので429に当たりやすく、実際に
      //    2026-08 立川の請求が全額¥0で作られ、そのまま確定保存された。
      //    他の取得箇所と同じく軽リトライ+503にし、0を返さない。
      // 🚨 元は resp.ok も見ずに Number(row[i])||0 としており、読み取り失敗で
      //    全単価が黙って0になっていた(2026-08 立川が¥0で確定保存された原因)。
      //    ただし 503 で止めると、単価シートが未整備な環境で請求書が一切作れなくなる。
      //    → 読めなければ prices を返さず ok:false を返し、呼び出し側に「既定値で計算し、
      //      画面に警告を出す」を選ばせる。0 は絶対に返さない。
      let row: any[]=[];
      let readErr='';
      try{
        const vals=await fetchSheetValuesWithRetry(`${BILL_PRICE_SHEET}!A2:W2`, ()=>getAccessToken());
        row=vals[0]||[];
      }catch(e){ readErr=String((e as any)?.message??e).slice(0,200); }
      if(readErr) return jsonResp({ok:false, error:'請求単価を読み込めませんでした（Sheetsの読み取り上限の可能性）', code:'SHEET_UNAVAILABLE', detail:readErr});
      const prices:any={};
      BILL_PRICE_KEYS.forEach((k,i)=>{prices[k]=Number(row[i])||0;});
      // 空行/全0は「読めていない」扱い。0の単価を返して請求書を¥0にしない。
      if(!BILL_PRICE_KEYS.some(k=>prices[k]>0)){
        return jsonResp({ok:false, error:'請求単価設定シートが空です（既定の単価で計算します）', code:'BILL_PRICES_EMPTY'});
      }
      return jsonResp({prices});
    }
    if(action==='save_bill_prices'){
      if(!admin) return forbid();
      if(!bill_prices) return jsonResp({error:'bill_prices required'}, 400);
      const row=BILL_PRICE_KEYS.map(k=>bill_prices[k]??0);
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(BILL_PRICE_SHEET)}!A2:W2?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      return jsonResp({success:true});
    }
    if(action==='get_employee_salaries'){
      // 社員の給料(月額)。会計ツールの社員給与マスタ acc_salaries を正とし、NexPort「社員給与の割り当て」で
      // その月(以前の月から引き継ぎ)に金額を上書きしていればそれを使う(NexPort の employee-salary EF と同じ決まり)。
      // 2026-10-26 社員管理・収支管理の給料を単価マスタの「月給」列から切り替え(山内=0・佐藤=475,000 のずれがあった)。
      if(!admin) return forbid();
      const ym=String((body as any).year_month||'');
      if(!/^\d{4}-\d{2}$/.test(ym)) return jsonResp({error:'year_month(YYYY-MM)が必要です'},400);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      const H = { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } as Record<string,string>;
      try{
        const [sr, ar] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/acc_salaries?select=profile_id,name,monthly_salary&active=eq.true`,{headers:H}),
          fetch(`${SB_URL}/rest/v1/employee_salary_allocations?select=profile_id,staff_name,year_month,monthly_amount&year_month=lte.${ym}`,{headers:H}),
        ]);
        if(!sr.ok||!ar.ok) return jsonResp({ok:false, error:`会計の給与を読めませんでした (${sr.status}/${ar.status})`});
        const sal=await sr.json() as any[]; const alc=await ar.json() as any[];
        // 月ごとの上書き: 人ごとにその月以前で一番新しい行
        const latest=new Map<string,any>();
        for(const r of alc){ const cur=latest.get(r.profile_id); if(!cur||r.year_month>cur.year_month) latest.set(r.profile_id,r); }
        const out:any[]=[];
        const seen=new Set<string>();
        for(const s of sal){
          const o=s.profile_id?latest.get(s.profile_id):null;
          const ov=o&&Number(o.monthly_amount)>0?Number(o.monthly_amount):0;
          out.push({name:String(s.name||''), monthly_salary:ov||Number(s.monthly_salary)||0, overridden:!!ov});
          if(s.profile_id) seen.add(s.profile_id);
        }
        // 会計に無くても割り当てで金額を入れている人
        for(const [pid,o] of latest){ if(!seen.has(pid)&&Number(o.monthly_amount)>0) out.push({name:String(o.staff_name||''), monthly_salary:Number(o.monthly_amount), overridden:true}); }
        return jsonResp({salaries:out});
      }catch(e){
        return jsonResp({ok:false, error:String((e as any)?.message??e).slice(0,200)});
      }
    }
    if(action==='get_btob_settings'){
      // BtoBプラットフォーム用の振込先と支払先コード。
      // 🚨 shift-manager のリポジトリは公開なので口座情報をコードに置けない。
      //    アスクルと同じ値を sm_billing_settings(key='btob') に持ち、ここからだけ返す。
      //    テーブルは RLS 有効でポリシー無し(= service_role 以外は読めない)。
      if(!admin) return forbid();
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({ok:false, error:'設定を読み出せませんでした'});
      try{
        const r = await fetch(`${SB_URL}/rest/v1/sm_billing_settings?select=data&key=eq.btob`,
          { headers: { 'apikey': SRK, 'Authorization': `Bearer ${SRK}` } });
        const j = await r.json();
        // 読めなかったときは空で返す。誤った口座を出すより空欄のほうが安全。
        return jsonResp({ settings: (Array.isArray(j) && j[0]?.data) ? j[0].data : null });
      }catch(e){
        return jsonResp({ok:false, error:String((e as any)?.message??e).slice(0,200)});
      }
    }
    if(action==='get_kawagoe_course_prices'){
      // 川越コース単価マスタ — 請求側の参照に使う。staff には不要なので admin のみ
      if(!admin) return forbid();
      const kw = await fetchKawagoeCourseRows(sheetsToken);
      const parseCourseRows = (rows: string[][]) => rows.filter((r:string[])=>r[0]).map((r:string[])=>({course:String(r[0]||'').trim(),mon:parseYenValue(r[2]),tue:parseYenValue(r[3]),wed:parseYenValue(r[4]),thu:parseYenValue(r[5]),fri:parseYenValue(r[6]),sat:parseYenValue(r[7]),sun:parseYenValue(r[8])}));
      // meta = 検出した旧/新のシート行番号とコース一覧。想定と合っているかを画面/ログで確認できる
      return jsonResp({old:parseCourseRows(kw.old),new:parseCourseRows(kw.new),meta:kw.meta});
    }
    if(action==='get_confirmed_sales'){
      if(!admin) return forbid();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:P5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rows=await sheetVals(resp);
      const numOrNull=(v:any)=> (v===undefined||v===null||v==='') ? null : (Number(v)||0);
      const all=rows.map((r:string[],i:number)=>{
        const ym = normalizeYM(r[0]);
        return {row_number:i+2,year_month:ym,area:r[1]||'',course:r[2]||'',grand_total:Number(r[3])||0,am_total:Number(r[4])||0,pm_total:Number(r[5])||0,confirmed_at:r[6]||'',
          counts:{am:numOrNull(r[7]),am_tokushu:numOrNull(r[8]),am_zasshi:numOrNull(r[9]),am_dokkon:numOrNull(r[10]),am_kyori:numOrNull(r[11]),pm:numOrNull(r[12]),pm_tokushu:numOrNull(r[13]),keiba:numOrNull(r[14]),keiba_tokushu:numOrNull(r[15])},
          _atMs:parseAtMs(r[6]||'')};
      }).filter((r:any)=>r.year_month&&r.area&&r.course);
      const dedup=new Map<string,any>();
      all.forEach((r:any)=>{
        const k=`${r.year_month}|${r.area}|${r.course}`;
        const ex=dedup.get(k);
        if(!ex||r._atMs>ex._atMs||(r._atMs===ex._atMs&&r.row_number>ex.row_number))dedup.set(k,r);
      });
      let records=[...dedup.values()].map(({_atMs,...rest})=>rest);
      if(year_month){
        const ymNorm=normalizeYM(year_month);
        records=records.filter((r:any)=>r.year_month===ymNorm);
      }
      return jsonResp({records});
    }
    if(action==='save_confirmed_sale'){
      if(!admin) return forbid();
      if(!confirmed_sale) return jsonResp({error:'confirmed_sale required'}, 400);
      const{year_month:ymRaw,area:ar,course:cs,grand_total,am_total,pm_total,counts}=confirmed_sale;
      const ym = normalizeYM(ymRaw);
      if(!ym||!ar||!cs) return jsonResp({error:'year_month, area, course required'}, 400);
      const now=new Date().toISOString().replace('T',' ').slice(0,19);
      // H〜P: 店舗数(振り返り統計用)。 未指定なら空文字(0扱い)。
      const c=counts||{};
      const n=(v:any)=> (v===undefined||v===null||v==='') ? '' : (Number(v)||0);
      const newRow=[ym,ar,cs,grand_total||0,am_total||0,pm_total||0,now,
        n(c.am),n(c.am_tokushu),n(c.am_zasshi),n(c.am_dokkon),n(c.am_kyori),n(c.pm),n(c.pm_tokushu),n(c.keiba),n(c.keiba_tokushu)];
      const existResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:P5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const existRows=await sheetVals(existResp);
      const matchIdx=existRows.findIndex((r:string[])=>normalizeYM(r[0])===ym&&r[1]===ar&&r[2]===cs);
      if(matchIdx>=0){
        const rn=matchIdx+2;
        // counts 未指定の更新(金額のみ編集など)では既存の店舗数(H〜P)を維持
        if(!counts){ const ex=existRows[matchIdx]||[]; for(let k=7;k<=15;k++) newRow[k]=(ex[k]!==undefined?ex[k]:''); }
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A${rn}:P${rn}?valueInputOption=RAW`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[newRow]})});
      }else{
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A1:P1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[newRow]})});
      }
      return jsonResp({success:true});
    }
    // 確定の一括保存。1コースずつ save_confirmed_sale を叩くと、コースごとに
    // シート全体(A2:P5000)を読むため、45コースで読み取り45回になり Sheets の
    // 「1分あたり60回」上限に当たって途中で 429 で落ちる(2026-07 立川で発生)。
    // ここでは読み取り1回・書き込み1回にまとめる。
    if(action==='save_confirmed_sales_bulk'){
      if(!admin) return forbid();
      const list = Array.isArray(body.confirmed_sales) ? body.confirmed_sales : [];
      if(!list.length) return jsonResp({error:'confirmed_sales required'}, 400);
      const now=new Date().toISOString().replace('T',' ').slice(0,19);
      const n=(v:any)=> (v===undefined||v===null||v==='') ? '' : (Number(v)||0);
      const existResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:P5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const existRows=await sheetVals(existResp);
      const idxOf=new Map<string,number>();
      existRows.forEach((r:string[],i:number)=>{
        const k=`${normalizeYM(r[0])}\u0001${(r[1]||'').trim()}\u0001${(r[2]||'').trim()}`;
        if(!idxOf.has(k)) idxOf.set(k,i);
      });
      const updates:any[]=[]; const appends:any[]=[]; const saved:string[]=[]; const skipped:any[]=[];
      for(const it of list){
        const ym=normalizeYM(it?.year_month); const ar=it?.area; const cs=it?.course;
        if(!ym||!ar||!cs){ skipped.push({course:cs??'', reason:'year_month/area/course がありません'}); continue; }
        const c=it.counts||{};
        const row=[ym,ar,cs,it.grand_total||0,it.am_total||0,it.pm_total||0,now,
          n(c.am),n(c.am_tokushu),n(c.am_zasshi),n(c.am_dokkon),n(c.am_kyori),n(c.pm),n(c.pm_tokushu),n(c.keiba),n(c.keiba_tokushu)];
        const k=`${ym}\u0001${ar}\u0001${cs}`;
        const at=idxOf.get(k);
        if(at!==undefined){
          // counts 未指定の更新では既存の店舗数(H〜P)を維持(単体保存と同じ規則)
          if(!it.counts){ const ex=existRows[at]||[]; for(let j=7;j<=15;j++) row[j]=(ex[j]!==undefined?ex[j]:''); }
          const rn=at+2;
          updates.push({range:`${CONFIRMED_SALES_SHEET}!A${rn}:P${rn}`,values:[row]});
        }else{
          appends.push(row);
        }
        saved.push(cs);
      }
      if(updates.length){
        const r1=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data:updates})});
        if(!r1.ok) return jsonResp({error:`確定の更新に失敗しました (HTTP ${r1.status}): ${(await r1.text()).slice(0,300)}`}, 502);
      }
      if(appends.length){
        const r2=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A1:P1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:appends})});
        if(!r2.ok) return jsonResp({error:`確定の追加に失敗しました (HTTP ${r2.status}): ${(await r2.text()).slice(0,300)}`}, 502);
      }
      return jsonResp({success:true, saved:saved.length, updated:updates.length, appended:appends.length, skipped});
    }
    if(action==='unconfirm_sale'){
      if(!admin) return forbid();
      if(!year_month||!area||!course) return jsonResp({error:'year_month, area, course required'}, 400);
      const ymNorm = normalizeYM(year_month);
      const existResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:G5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const existRows=await sheetVals(existResp);
      const matches:number[]=[];
      existRows.forEach((r:string[],i:number)=>{
        if(normalizeYM(r[0])===ymNorm&&r[1]===area&&r[2]===course)matches.push(i+2);
      });
      if(matches.length>0){
        const data=matches.map(rn=>({range:`${CONFIRMED_SALES_SHEET}!A${rn}:G${rn}`,values:[Array(7).fill('')]}));
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data})});
      }
      return jsonResp({success:true,cleared:matches.length});
    }
    // ----- システム設定 (機能表示制御 等) -----
    if(action==='get_feature_visibility'){
      // 全員が読める (ログインしたユーザのナビ反映用)
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SETTINGS_SHEET)}!A1:B1`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const row=(await resp.json()).values?.[0]||[];
      let config = {};
      if(row[0]==='feature_visibility' && row[1]){
        try{ config = JSON.parse(row[1]); }catch(_){}
      }
      return jsonResp({ feature_visibility: config });
    }
    if(action==='save_feature_visibility'){
      if(!admin) return forbid();
      const cfg = body.feature_visibility || {};
      // sanitize: 値は boolean のみ許可
      const clean: Record<string,boolean> = {};
      for(const k of Object.keys(cfg)){
        if(typeof cfg[k] === 'boolean') clean[k] = cfg[k];
      }
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SETTINGS_SHEET)}!A1:B1?valueInputOption=RAW`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[['feature_visibility', JSON.stringify(clean)]]})});
      return jsonResp({success:true, feature_visibility: clean});
    }
    return jsonResp({error:'Unknown action'});
  }catch(e:any){
    // Sheets 読み取り失敗は 502 で返す (500 と区別して原因を画面に出せるようにする)
    if(e instanceof SheetsReadError) return jsonResp({error:e.message}, 502);
    return jsonResp({error:e.message}, 500);
  }
});
