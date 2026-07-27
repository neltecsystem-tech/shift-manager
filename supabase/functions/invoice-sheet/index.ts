import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
const MEASURE_SHEET = '測定記録';
const BILL_PRICE_SHEET = '請求単価設定';
const CONFIRMED_SALES_SHEET = '売上確定';
const SETTINGS_SHEET = 'システム設定';
const BILL_PRICE_KEYS = ['am_shop','am_dokkon','am_tokushu','am_zasshi','am_kanri','pm_normal','pm_special','pm_tokushu','pm_kanri','keiba_also_pm','keiba_only','keiba_special','keiba_tokushu','keiba_kanri','kw_am_shop','kw_am_dokkon','kw_am_tokushu','kw_am_zasshi','kw_am_kanri','kw_kyori','kw_pm','kw_pm_tokushu','kw_pm_kanri'];
const BILL_PRICE_HEADERS = ['朝刊店舗','朝刊同梱','朝刊特殊','朝刊雑誌','朝刊管理費','夕刊通常','夕刊特別','夕刊特殊','夕刊管理費','競馬併用','競馬のみ','競馬特別','競馬特殊','競馬管理費','川越朝刊店舗','川越朝刊同梱','川越朝刊特殊','川越朝刊雑誌','川越朝刊管理費','川越距離増','川越夕刊/競馬','川越夕刊特殊','川越夕刊管理費'];
const CONFIRMED_SALES_HEADERS = ['年月','営業所','コース','合計金額','朝刊小計','夕刊小計','確定日時'];
const KAWAGOE_MASTER_SHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const KAWAGOE_MASTER_SHEET_NAME = 'マスタ2';

const RATE_HEADERS = ['スタッフ名','朝刊(月-金)','朝刊(土)','夕刊/競馬(月-木)','夕刊/競馬(金-土)','庫内朝刊','庫内夕刊','計算方式','個数単価','ログインID','パスワード','区分','所属会社','夕刊計算方式','夕刊個数単価','朝刊(日)','夕刊(日)','表示権限','川越朝刊曜日別','川越パターン','月給','インボイス番号','単価適用日'];

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);
const SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';
const ADMIN_PASSWORD = Deno.env.get('SHIFT_ADMIN_PASSWORD') || 'neltec2026';
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
  return { ...r, unit_price: '', amount: '', am_weekday: '', am_weekend: '', pm_weekday: '', pm_weekend: '', warehouse_am: '', warehouse_pm: '', unit_price_pm: '', am_sunday: '', pm_sunday: '', monthly_salary: '' };
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
// 同じ company の名前リスト (オーナー含む) を取得 (法人オーナー権限スコープ用)
async function fetchCompanyNames(sheetsToken: string, company: string): Promise<string[]> {
  if (!company) return [];
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`, { headers: { 'Authorization': `Bearer ${sheetsToken}` } });
  const rows = (await resp.json()).values || [];
  const list = parseRates(rows).filter((r: any) => r.biz_type === '法人' && r.company === company);
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
async function fetchSheetValuesWithRetry(range: string, tokenGetter: ()=>Promise<string>, tries=3): Promise<any[]> {
  let lastErr: any=null;
  for(let i=0;i<tries;i++){
    try{
      const token=await tokenGetter();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`,{headers:{'Authorization':`Bearer ${token}`}});
      if(resp.ok){ const j=await resp.json().catch(()=>({})); return j.values||[]; }
      lastErr=new Error(`sheet_http_${resp.status}`);
    }catch(e){ lastErr=e; }
    if(i<tries-1) await new Promise(r=>setTimeout(r, 300*Math.pow(2,i))); // 300ms,600ms
  }
  throw lastErr||new Error('sheet_fetch_failed');
}
function parseRates(rows: string[][]) {
  return rows.map((r:string[],i:number)=>({row_number:i+2,name:r[0]||'',am_weekday:r[1]||'',am_weekend:r[2]||'',pm_weekday:r[3]||'',pm_weekend:r[4]||'',warehouse_am:r[5]||'',warehouse_pm:r[6]||'',calc_type:r[7]||'固定',unit_price:r[8]||'',login_id:r[9]||'',login_pw:r[10]||'',biz_type:r[11]||'',company:r[12]||'',calc_type_pm:r[13]||'',unit_price_pm:r[14]||'',am_sunday:r[15]||'',pm_sunday:r[16]||'',permissions:r[17]||'',kw_am_daily:r[18]||'',kw_pattern:r[19]||'',monthly_salary:r[20]||'',invoice_number:r[21]||'',rate_effective_from:r[22]||''})).filter((o:any)=>o.name);
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
    const rows = await fetchSheetValuesWithRetry('単価マスタ!A2:W1000', getAccessToken);
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
  const existing=((await metaResp.json()).sheets||[]).map((s:any)=>s.properties.title);
  const requests:any[]=[];
  if(!existing.includes('単価マスタ'))requests.push({addSheet:{properties:{title:'単価マスタ'}}});
  if(!existing.includes('稼働記録'))requests.push({addSheet:{properties:{title:'稼働記録'}}});
  if(!existing.includes(MEASURE_SHEET))requests.push({addSheet:{properties:{title:MEASURE_SHEET}}});
  if(!existing.includes(BILL_PRICE_SHEET))requests.push({addSheet:{properties:{title:BILL_PRICE_SHEET}}});
  if(!existing.includes(CONFIRMED_SALES_SHEET))requests.push({addSheet:{properties:{title:CONFIRMED_SALES_SHEET}}});
  if(!existing.includes(SETTINGS_SHEET))requests.push({addSheet:{properties:{title:SETTINGS_SHEET}}});
  if(requests.length>0)await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requests})});
  const hr=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A1:W1`,{headers:{'Authorization':`Bearer ${token}`}});
  const ch=(await hr.json()).values?.[0]||[];
  if(ch.length<RATE_HEADERS.length||!ch.includes('単価適用日')){
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A1:W1?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[RATE_HEADERS]})});
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

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  try{
    const body = await req.json();
    const { action, record, row_number, row_numbers, updates, login_id, login_pw, measure_data, bill_prices, confirmed_sale, year_month, area, course, admin_password, auth_token } = body;

    // ---- 認証不要のアクション: login / admin_login ----
    if(action==='login'){
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
      if(!row || !authOk) return jsonResp({success:false,error:'IDまたはパスワードが正しくありません'});
      const match=row;
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
      const allRates = parseRates(rateRows);
      // 本人(corp-sub)の行に show_money があれば金額を見せる (メンバー個別制御)
      const company_shows_money = is_corp_sub ? permList.includes('show_money') : true;
      const sessionToken = await createToken({ role: tokenRole, name, biz_type, company, permissions, is_corp_sub, is_owner, company_shows_money });
      // 単価 + 稼働のスコープ: admin=全件 / corp-owner=同company全員 / それ以外=自分のみ
      // 稼働記録は認証には不要(表示用)なので、取得できなくてもログインは通す(空扱い)。
      let workValues: any[] = [];
      try{ workValues = await fetchSheetValuesWithRetry('稼働記録!A2:J5000', getAccessToken); }catch(_e){ workValues = []; }
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
      if(!admin_password || admin_password !== ADMIN_PASSWORD) return jsonResp({success:false,error:'管理者パスワードが正しくありません'},401);
      const sessionToken = await createToken({ role: 'admin', name: 'admin' });
      return jsonResp({success:true, auth_token: sessionToken});
    }

    // ── 会計ツール連携: 単価マスタの T番号(invoice_number) を Supabase テーブルへ同期 ──
    //   admin_password または cron秘密ヘッダ(x-sync-secret)でゲート。会計側は acc_shift_invoice_numbers を読むだけ。
    if(action==='sync_invoice_numbers'){
      const cronSecret = req.headers.get('x-sync-secret') || '';
      const okCron = !!SYNC_SECRET && cronSecret === SYNC_SECRET;
      if(!okCron && admin_password !== ADMIN_PASSWORD) return jsonResp({error:'forbidden'},403);
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const token = await getAccessToken();
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${token}`}});
      const rates = parseRates((await resp.json()).values||[]);
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
      if(!okCron && admin_password !== ADMIN_PASSWORD) return jsonResp({error:'forbidden'},403);
      const dryRun = !!body.dry_run;
      const SB_URL = Deno.env.get('SUPABASE_URL') || '';
      const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if(!SB_URL || !SRK) return jsonResp({error:'supabase env missing'},500);
      const pr = await fetch(`${SB_URL}/rest/v1/acc_invoice_partners?select=name,invoice_number`,{headers:{'apikey':SRK,'Authorization':`Bearer ${SRK}`}});
      const partners = (await pr.json()) as any[];
      const pmap = new Map<string,string>();
      partners.forEach((p:any)=>{ const t=(p.invoice_number||'').trim(); if(t) pmap.set(normPartner(p.name), t); });
      const token = await getAccessToken();
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${token}`}});
      const rates = parseRates((await resp.json()).values||[]);
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
      if(!okCron && admin_password !== ADMIN_PASSWORD) return jsonResp({error:'forbidden'},403);
      const dryRun = !!body.dry_run;
      const onlyZero = body.only_zero !== false; // 既定true: 金額0の未計算行のみ補完(既存の非0金額は触らない=履歴保護)
      const token = await getAccessToken();
      const [rRes, wRes, sRes, kwOldRes, kwNewRes] = await Promise.all([
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPECIAL_SHEET_ID}/values/${encodeURIComponent(SPECIAL_SHEET_NAME)}!A2:J5000`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${KAWAGOE_MASTER_SHEET_ID}/values/${encodeURIComponent(KAWAGOE_MASTER_SHEET_NAME)}!AN2:AV20`,{headers:{'Authorization':`Bearer ${token}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${KAWAGOE_MASTER_SHEET_ID}/values/${encodeURIComponent(KAWAGOE_MASTER_SHEET_NAME)}!AN22:AV34`,{headers:{'Authorization':`Bearer ${token}`}}),
      ]);
      const rates = parseRates((await rRes.json()).values||[]);
      const work = parseWork((await wRes.json()).values||[]);
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
        '旧': parseKwCourses((await kwOldRes.json()).values||[]),
        '新': parseKwCourses((await kwNewRes.json()).values||[]),
      };
      const rateByName = new Map<string,any>(rates.map((r:any)=>[r.name, r]));
      const nn = (s:string)=>String(s||'').replace(/[\s　]+/g,'').trim();
      // 特別単価を (日付|氏名) でインデックス化 (O(1)照合)
      const specIndex = new Map<string, any[]>();
      (((await sRes.json()).values||[]) as string[][]).filter(r=>r[1]&&r[2]).forEach(r=>{
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
        const rate = rateByName.get(w.staff); if(!rate){ noRate++; continue; }
        if((w.confirmed||'').toString().trim()){ skipConf++; continue; }
        const eff = (rate.rate_effective_from||'').replace(/\//g,'-');
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
      if(!okCron && admin_password !== ADMIN_PASSWORD) return jsonResp({error:'forbidden'},403);
      const ym = normalizeYM(year_month);
      if(!ym) return jsonResp({error:'year_month required'},400);
      const token = await getAccessToken();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:P5000`,{headers:{'Authorization':`Bearer ${token}`}});
      const rows=(await resp.json()).values||[];
      // (ym,area,course) の最新行のみ採用 (get_confirmed_sales と同じ重複排除)
      const dedup=new Map<string,{area:string;grand:number;atMs:number}>();
      rows.forEach((r:string[])=>{
        if(normalizeYM(r[0])!==ym) return; const area=(r[1]||'').trim(); const course=(r[2]||'').trim(); if(!area||!course) return;
        const atMs=parseAtMs(r[6]||''); const k=`${area}|${course}`; const ex=dedup.get(k);
        if(!ex||atMs>=ex.atMs) dedup.set(k,{area,grand:Number(r[3])||0,atMs});
      });
      const byArea:Record<string,number>={};
      dedup.forEach(v=>{ byArea[v.area]=(byArea[v.area]||0)+v.grand; });
      return jsonResp({year_month:ym, by_area:byArea});
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
        const names=[...new Set(((await resp.json()).values||[]).map((r:string[])=>(r[0]||'').trim()).filter(Boolean))];
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
      const rows=(await resp.json()).values||[];
      return jsonResp({rows});
    }
    if(action==='get_special_rates'){
      if(!admin) return forbid();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPECIAL_SHEET_ID}/values/${encodeURIComponent(SPECIAL_SHEET_NAME)}!A2:J5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rows=((await resp.json()).values||[]).filter((r:string[])=>r[1]&&r[2]);
      const records=rows.map((r:string[])=>({timestamp:r[0]||'',date:r[1]||'',name:r[2]||'',amount:r[3]||'',reason:r[4]||'',applicant:r[5]||'',category:r[6]||'',type:r[7]||'',office:r[8]||''}));
      return jsonResp({records});
    }
    if(action==='get_rates'){
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const all = parseRates((await resp.json()).values||[]);
      if (admin) return jsonResp({rates: all});
      // staff/owner: scopeNames に含まれる行のみ。corp-sub は金額系も剥がす (自社オーナーが show_money ON なら剥がさない=ライブ判定)
      const csm = !corpSub || memberShowsMoney(all, callerName);
      const scope = await getScopeNames();
      const out = all.filter((r:any)=>scope.has(r.name)).map((r:any)=> (corpSub && !csm) ? stripPrices(stripStaffPrivate(r)) : stripStaffPrivate(r));
      return jsonResp({rates: out, company_shows_money: csm});
    }
    if(action==='save_rate'){
      if(!admin) return forbid();
      if(!record?.name) return jsonResp({error:'name required'}, 400);
      const row=[record.name,record.am_weekday||'',record.am_weekend||'',record.pm_weekday||'',record.pm_weekend||'',record.warehouse_am||'',record.warehouse_pm||'',record.calc_type||'固定',record.unit_price||'',record.login_id||'',record.login_pw||'',record.biz_type||'',record.company||'',record.calc_type_pm||'固定',record.unit_price_pm||'',record.am_sunday||'',record.pm_sunday||'',record.permissions||'',record.kw_am_daily||'',record.kw_pattern||'',record.monthly_salary||'',record.invoice_number||'',record.rate_effective_from||''];
      if(row_number){await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A${row_number}:W${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});}
      else{await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A1:W1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});}
      await invalidateRateCache();
      return jsonResp({success:true});
    }
    if(action==='change_password'){
      // 本人のログインパスワード変更 (現在PWをサーバ側で照合)。adminは login_id 指定で任意ユーザー可。
      const oldPw = String(body.old_pw ?? '').trim();
      const newPw = String(body.new_pw ?? '').trim();
      if(newPw.length < 3) return jsonResp({error:'新しいパスワードは3文字以上にしてください'}, 400);
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rates = parseRates((await resp.json()).values||[]);
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
      const delResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{deleteDimension:{range:{sheetId:RATE_SHEET_ID,dimension:'ROWS',startIndex:rowIdx,endIndex:rowIdx+1}}}]})});
      if(!delResp.ok){
        const errText=await delResp.text();
        return jsonResp({error:'deleteDimension failed: '+delResp.status+' '+errText.slice(0,200)}, 500);
      }
      await invalidateRateCache();
      return jsonResp({success:true});
    }
    // ── 法人オーナー: 自社メンバーのみ管理 (単価は保全=編集不可, 会社/区分は固定) ──
    if(action==='owner_save_member'){
      if(!corpOwner) return forbid();
      if(!callerCompany) return forbid('会社情報がありません');
      if(!record?.name) return jsonResp({error:'name required'}, 400);
      const cur = parseRates((await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}})).json()).values||[]);
      let base: any = {};
      if(row_number){
        base = cur.find((r:any)=>r.row_number===Number(row_number));
        if(!base) return jsonResp({error:'row not found'}, 404);
        if(base.company!==callerCompany) return forbid('自社メンバーのみ編集できます');
      }
      const isSelf = row_number ? (base.name===callerName) : false; // 新規は常に配下扱い
      // 価格系は base から保全 (オーナーは編集不可)。 オーナーが触れるのは 氏名/ログイン/show_money のみ
      const m: any = { ...base };
      m.name = record.name;
      m.login_id = record.login_id ? record.login_id : (base.login_id||''); // 空欄は現状維持
      m.login_pw = record.login_pw ? record.login_pw : (base.login_pw||''); // 空欄は現状維持(編集時PW消さない)
      m.biz_type = '法人';
      m.company = callerCompany;
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
      const cur = parseRates((await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}})).json()).values||[]);
      const tgt = cur.find((r:any)=>r.row_number===Number(row_number));
      if(!tgt) return jsonResp({error:'row not found'}, 404);
      if(tgt.company!==callerCompany) return forbid('自社メンバーのみ削除できます');
      if(tgt.name===callerName) return forbid('自分自身は削除できません');
      const rowIdx=Number(row_number)-1;
      if(rowIdx<1) return jsonResp({error:'cannot delete header'}, 400);
      const delResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{deleteDimension:{range:{sheetId:RATE_SHEET_ID,dimension:'ROWS',startIndex:rowIdx,endIndex:rowIdx+1}}}]})});
      if(!delResp.ok){ return jsonResp({error:'delete failed: '+delResp.status+' '+(await delResp.text()).slice(0,200)}, 500); }
      await invalidateRateCache();
      return jsonResp({success:true});
    }
    if(action==='list_work'){
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const all = parseWork((await resp.json()).values||[]);
      if (admin) return jsonResp({records: all});
      // corp-sub の金額表示はライブ判定 (自社オーナーの show_money を都度参照)
      let csm = true;
      if (corpSub) {
        const rr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('単価マスタ')}!A2:W200`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
        csm = memberShowsMoney(parseRates((await rr.json()).values||[]), callerName);
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
        const exWork=parseWork((await exResp.json()).values||[]);
        const key=workDupKey(record);
        const dup=exWork.find((w:any)=>workDupKey(w)===key);
        if(dup) return jsonResp({error:`二重計上: 同じ稼働(${dup.date} ${dup.staff} / ${dup.category} / ${dup.course||'コース無し'})が既に登録されています`, code:'DUPLICATE'}, 409);
      }
      const row=[record.date||'',record.staff||'',record.course||'',record.category||'',record.start_time||'',record.end_time||'',record.quantity||'',record.unit_price||'',record.amount||'',''];
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A1:J1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
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
        const exWork=parseWork((await exResp.json()).values||[]);
        const key=workDupKey({staff:record.staff||callerName,date:record.date,category:record.category,course:record.course});
        const dup=exWork.find((w:any)=>w.row_number!==Number(row_number)&&workDupKey(w)===key);
        if(dup) return jsonResp({error:`二重計上: 同じ稼働(${dup.date} ${dup.staff} / ${dup.category} / ${dup.course||'コース無し'})が既に登録されています`, code:'DUPLICATE'}, 409);
      }
      const row=[record.date||'',record.staff||callerName,record.course||'',record.category||'',record.start_time||'',record.end_time||'',record.quantity||'',record.unit_price||'',record.amount||''];
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A${row_number}:I${row_number}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
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
      return jsonResp({success:true});
    }
    if(action==='batch_recalc_amounts'){
      // updates=[{row_number, unit_price, amount}] を 稼働記録 H:I へ一括反映。
      // 確定済み行・スコープ外行はスキップ。クライアントが単価マスタで再計算した値を渡す。
      if(!Array.isArray(row_numbers) && !Array.isArray(updates)) return jsonResp({error:'updates required'},400);
      const ups = (updates || []) as any[];
      if(!ups.length) return jsonResp({success:true, updated:0, skipped:0});
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent('稼働記録')}!A2:J5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const all = parseWork((await resp.json()).values||[]);
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
      return jsonResp({success:true,confirmed:row_numbers.length});
    }
    if(action==='unconfirm_records'){
      if(!admin) return forbid();
      if(!row_numbers||!row_numbers.length) return jsonResp({error:'row_numbers required'}, 400);
      const data:any[]=[];
      for(const rn of row_numbers){data.push({range:`'稼働記録'!J${rn}`,values:[['']]});}
      const ucResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({valueInputOption:'USER_ENTERED',data})});
      if(!ucResp.ok){ const t=await ucResp.text(); return jsonResp({error:'確定解除の書き込みに失敗しました: '+ucResp.status+' '+t.slice(0,200)},500); }
      return jsonResp({success:true,unconfirmed:row_numbers.length});
    }
    if(action==='list_measure'){
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A2:H10000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rows=((await resp.json()).values||[]).filter((r:string[])=>r[0]||r[1]);
      const records=rows.map((r:string[])=>({date:r[0]||'',course:r[1]||'',type:r[2]||'',start_time:r[3]||'',end_time:r[4]||'',shop_name:r[5]||'',arrival_time:r[6]||'',staff:r[7]||''}));
      return jsonResp({records});
    }
    if(action==='save_measure'){
      if(!measure_data) return jsonResp({error:'measure_data required'}, 400);
      const{date,course,type,start_time,end_time,staff,shops}=measure_data;
      // staff は自分の名前のみ
      const staffName = admin ? (staff || '') : callerName;
      const rows=(shops||[]).map((s:any)=>[date||'',course||'',type||'',start_time||'',end_time||'',s.name||'',s.time||'',staffName]);
      if(rows.length){await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MEASURE_SHEET)}!A1:H1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:rows})});}
      return jsonResp({success:true,saved:rows.length});
    }
    if(action==='get_bill_prices'){
      if(!admin) return forbid();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(BILL_PRICE_SHEET)}!A2:W2`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const row=(await resp.json()).values?.[0]||[];
      const prices:any={};
      BILL_PRICE_KEYS.forEach((k,i)=>{prices[k]=Number(row[i])||0;});
      return jsonResp({prices});
    }
    if(action==='save_bill_prices'){
      if(!admin) return forbid();
      if(!bill_prices) return jsonResp({error:'bill_prices required'}, 400);
      const row=BILL_PRICE_KEYS.map(k=>bill_prices[k]??0);
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(BILL_PRICE_SHEET)}!A2:W2?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Authorization':`Bearer ${sheetsToken}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      return jsonResp({success:true});
    }
    if(action==='get_kawagoe_course_prices'){
      // 川越コース単価マスタ — 請求側の参照に使う。staff には不要なので admin のみ
      if(!admin) return forbid();
      const [oldResp, newResp] = await Promise.all([
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${KAWAGOE_MASTER_SHEET_ID}/values/${encodeURIComponent(KAWAGOE_MASTER_SHEET_NAME)}!AN2:AV20`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${KAWAGOE_MASTER_SHEET_ID}/values/${encodeURIComponent(KAWAGOE_MASTER_SHEET_NAME)}!AN22:AV34`,{headers:{'Authorization':`Bearer ${sheetsToken}`}}),
      ]);
      const parseCourseRows = (rows: string[][]) => rows.filter((r:string[])=>r[0]).map((r:string[])=>({course:r[0]||'',mon:parseYenValue(r[2]),tue:parseYenValue(r[3]),wed:parseYenValue(r[4]),thu:parseYenValue(r[5]),fri:parseYenValue(r[6]),sat:parseYenValue(r[7]),sun:parseYenValue(r[8])}));
      const oldData = parseCourseRows((await oldResp.json()).values||[]);
      const newData = parseCourseRows((await newResp.json()).values||[]);
      return jsonResp({old:oldData,new:newData});
    }
    if(action==='get_confirmed_sales'){
      if(!admin) return forbid();
      const resp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:P5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const rows=(await resp.json()).values||[];
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
      const existRows=(await existResp.json()).values||[];
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
    if(action==='unconfirm_sale'){
      if(!admin) return forbid();
      if(!year_month||!area||!course) return jsonResp({error:'year_month, area, course required'}, 400);
      const ymNorm = normalizeYM(year_month);
      const existResp=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CONFIRMED_SALES_SHEET)}!A2:G5000`,{headers:{'Authorization':`Bearer ${sheetsToken}`}});
      const existRows=(await existResp.json()).values||[];
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
    return jsonResp({error:e.message}, 500);
  }
});
