// 新聞(東京即売)支払明細のサーバ側自動確定。index.html admPayBuildStatement/invCalcKodate/parseShift を1:1移植。
// データ源: shift_sheet_cache(生シフト) + invoice-sheet(単価/特別/川越, adminトークン自前生成) + shop-master(店舗マスタ) + bill_conditions(請求条件)。
// 出力: closed_pay_statements upsert(staff_name,year,month)。非社員かつ稼働ありのみ。
// mode: 'finalize'(既定/dry_run既定true)。書込は service_role bearer or body.cron_secret(automation_config)。
import { createClient } from 'jsr:@supabase/supabase-js@2';

const REF = 'nccognptoprhwsbjnwcu';
const BASE = `https://${REF}.supabase.co`;
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jY29nbnB0b3ByaHdzYmpud2N1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNDU0NDEsImV4cCI6MjA4OTkyMTQ0MX0.M3h31uPyKYWlNevVW3OvZOonoTidC1KLZ04sB5nRKzU';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';

// ── admin トークン生成 (invoice-sheet createToken と同一) ──
function b64urlEncode(s: string): string { const bytes = new TextEncoder().encode(s); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function hmacSign(payload: string): Promise<string> { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)); return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function adminToken(): Promise<string> { const payload = b64urlEncode(JSON.stringify({ role: 'admin', exp: Date.now() + 60000 })); return `${payload}.${await hmacSign(payload)}`; }
async function invApi(action: string, token: string): Promise<any> {
  const r = await fetch(`${BASE}/functions/v1/invoice-sheet`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON }, body: JSON.stringify({ action, auth_token: token }) });
  return await r.json().catch(() => ({}));
}

// ── ユーティリティ (js/utils.js と同一) ──
const isDateVal = (v: string) => !!v && /^0?\d{1,2}\/\d{1,2}$/.test(v);
const invNormName = (n: unknown) => String(n ?? '').replace(/[\s　 ]+/g, '').trim();
// 会社名の表記ゆれ吸収 (invoice-sheet と同じ規則)。「TLC.ﾊﾟｰﾄﾅｰｽﾞ㈱」と
// 「TLC.パートナーズ株式会社」を同一視するため、only_company の照合に使う。
const coKey = (s: unknown) => String(s ?? '')
  .normalize('NFKC')
  .replace(/株式会社|合同会社|有限会社|（株）|\(株\)|㈱|（合）|\(合\)|（有）|\(有\)/g, '')
  .replace(/[\s　・,，\.。\-－―ー]/g, '')
  .toLowerCase().trim();
// 半角カナ → 全角カナ (会社名の表記ゆれ吸収用。濁点・半濁点の合字を先に処理)
const HW_KANA2: Record<string, string> = { 'ｶﾞ': 'ガ', 'ｷﾞ': 'ギ', 'ｸﾞ': 'グ', 'ｹﾞ': 'ゲ', 'ｺﾞ': 'ゴ', 'ｻﾞ': 'ザ', 'ｼﾞ': 'ジ', 'ｽﾞ': 'ズ', 'ｾﾞ': 'ゼ', 'ｿﾞ': 'ゾ', 'ﾀﾞ': 'ダ', 'ﾁﾞ': 'ヂ', 'ﾂﾞ': 'ヅ', 'ﾃﾞ': 'デ', 'ﾄﾞ': 'ド', 'ﾊﾞ': 'バ', 'ﾋﾞ': 'ビ', 'ﾌﾞ': 'ブ', 'ﾍﾞ': 'ベ', 'ﾎﾞ': 'ボ', 'ｳﾞ': 'ヴ', 'ﾊﾟ': 'パ', 'ﾋﾟ': 'ピ', 'ﾌﾟ': 'プ', 'ﾍﾟ': 'ペ', 'ﾎﾟ': 'ポ' };
const HW_KANA1: Record<string, string> = { 'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ', 'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク', 'ｹ': 'ケ', 'ｺ': 'コ', 'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ', 'ﾀ': 'タ', 'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト', 'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ', 'ﾉ': 'ノ', 'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ', 'ﾏ': 'マ', 'ﾐ': 'ミ', 'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ', 'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ', 'ﾗ': 'ラ', 'ﾘ': 'リ', 'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ', 'ﾜ': 'ワ', 'ｦ': 'ヲ', 'ﾝ': 'ン', 'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ', 'ｯ': 'ッ', 'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ', 'ｰ': 'ー', '･': '・' };
const hwKanaToFw = (v: unknown) => { let s = String(v ?? ''); for (const k in HW_KANA2) s = s.split(k).join(HW_KANA2[k]); for (const k in HW_KANA1) s = s.split(k).join(HW_KANA1[k]); return s; };
function areaOfCourse(c: string): string { if (!c) return ''; if (c.startsWith('城北')) return '城北'; if (c.startsWith('川越')) return '川越'; if (c.startsWith('立川')) return '立川'; if (c.startsWith('川崎')) return '川崎高津'; return ''; }
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const ADM_PAY_NONPAID = /ミーティング|希望休|研修|有給|欠勤|出張|五反田|目黒|渋谷|休刊/;
const ADM_PAY_HIKITSUGI = /引継/;
function isNonPaid(v: any): boolean { if (v == null) return true; const s = String(v).trim(); if (!s || s === '0') return true; return ADM_PAY_NONPAID.test(s); }
function isHikitsugi(v: any): boolean { return v != null && ADM_PAY_HIKITSUGI.test(String(v)); }
function stripHikitsugi(v: any): string { return String(v || '').replace(/引継/g, '').replace(/^[\s　]+|[\s　]+$/g, ''); }

// ── parseShift 移植: 生rows(2D) → areaData[area][staffName][ymd]={am,pm} ──
function parseShiftRows(R: any[][], y: number) {
  const areaData: Record<string, Record<string, Record<string, { am: string; pm: string }>>> = {};
  if (!R || R.length < 10) return areaData;
  const dateRow = R[0], dowRow = R[3];
  const dates: { col: number; d: string }[] = [];
  for (let c = 1; c < dateRow.length; c++) {
    const v = String(dateRow[c] || '').trim();
    if (isDateVal(v)) { const parts = v.split('/').map(Number); const m = parts[parts.length - 2], d = parts[parts.length - 1]; dates.push({ col: c, d: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }); }
  }
  if (!dates.length) return areaData;
  const maxRow = Math.min(116, R.length);
  const numeric = (v: string) => /^\d{1,2}$/.test(v);
  for (let i = 6; i < maxRow; i++) {
    const r = R[i], courseName = String((r && r[0]) || '').trim();
    if (!courseName || courseName === '重複') continue;
    const area = areaOfCourse(courseName);
    if (!area) continue;
    for (const { col, d } of dates) {
      const am = String((r[col] || '')).trim(), pm = String((r[col + 1] || '')).trim();
      if (am && am !== '0' && !numeric(am)) { (areaData[area] ||= {}); (areaData[area][am] ||= {}); (areaData[area][am][d] ||= { am: '', pm: '' }); areaData[area][am][d].am = courseName; }
      if (pm && pm !== '0' && !numeric(pm)) { (areaData[area] ||= {}); (areaData[area][pm] ||= {}); (areaData[area][pm][d] ||= { am: '', pm: '' }); areaData[area][pm][d].pm = courseName; }
    }
  }
  // セクション2 (行120+): 特別値(ミーティング/引継等)。営業所ヘッダ+サブブロック。
  const special = /ミーティング|希望休|引継|研修|有給|欠勤|出張|五反田|目黒|渋谷|休刊/;
  const areas2 = ['城北', '川越', '立川', '川崎高津'];
  let curArea2 = '';
  for (let i = 120; i < R.length - 2; i++) {
    const a = String((R[i][0] || '')).trim(), b = String((R[i][1] || '')).trim();
    const isAreaHdr = areas2.some((x) => a === x) && isDateVal(b);
    const isSubHdr = a === '' && isDateVal(b) && curArea2;
    if (isAreaHdr || isSubHdr) {
      if (isAreaHdr) curArea2 = a;
      const s2dates: { col: number; d: string }[] = [];
      for (let c = 1; c < R[i].length; c++) { const v = String((R[i][c] || '')).trim(); if (isDateVal(v)) { const parts = v.split('/').map(Number); const m = parts[parts.length - 2], d = parts[parts.length - 1]; s2dates.push({ col: c, d: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }); } }
      let editionRow = R[i + 2] || [];
      const hasEd = (row: any[]) => row && row.some((v: any) => v && (String(v).includes('朝刊') || String(v).includes('夕刊') || String(v).includes('競馬')));
      if (!hasEd(editionRow)) { for (let er = i + 3; er < Math.min(R.length, i + 10); er++) { if (hasEd(R[er])) { editionRow = R[er]; break; } } }
      for (let j = i + 3; j < R.length; j++) {
        const r2 = R[j], nm = String((r2[0] || '')).trim(), colB = String((r2[1] || '')).trim();
        if (nm === '' && isDateVal(colB)) break;
        if (!nm) continue;
        if (/^\d{1,2}$/.test(nm)) continue;
        if (areas2.some((x) => nm === x) && isDateVal(colB)) break;
        for (const { col, d } of s2dates) {
          const v = String((r2[col] || '')).trim();
          if (!v || !special.test(v)) continue;
          const ed = String(editionRow[col] || '').trim();
          const isPm = ed.includes('夕刊') || ed.includes('競馬');
          (areaData[curArea2] ||= {}); (areaData[curArea2][nm] ||= {}); (areaData[curArea2][nm][d] ||= { am: '', pm: '' });
          if (isPm) areaData[curArea2][nm][d].pm = v; else areaData[curArea2][nm][d].am = v;
        }
      }
    }
  }
  return areaData;
}

// ── 店舗マスタ課金 invCalcKodate 移植 ──
function makeCalcKodate(shop: { headers: string[]; records: any[] }) {
  const headers = shop.headers || [], records = shop.records || [];
  let amCourseCol = -1, pmCourseCol = -1, keibaCourseCol = -1, tokushuCol = -1, yuukanCol = -1, kyoriCol = -1, zasshiCol = -1, pmTokushuCol = -1, keibaTokushuCol = -1;
  headers.forEach((h, i) => {
    if (h.includes('朝刊コース')) amCourseCol = i;
    if (h === '旧夕刊コース') { } else if (h.includes('夕刊コース')) pmCourseCol = i;
    if (h.includes('競馬コース')) keibaCourseCol = i;
    if (h === '朝刊特殊納品') tokushuCol = i;
    if (h === '夕刊同梱') yuukanCol = i;
    if (h === '距離増') kyoriCol = i;
    if (h === '雑誌') zasshiCol = i;
    if (h === '夕刊特殊納品') pmTokushuCol = i;
    if (h === '競馬特殊納品') keibaTokushuCol = i;
  });
  return (courseName: string, category: string) => {
    if (!courseName) return { amount: 0, detail: '', shopCount: 0, yuukan: 0, kyori: 0, tokushu: 0, zasshi: 0 };
    let courseCol = amCourseCol, tCol = tokushuCol;
    if (category === '夕刊/競馬') { courseCol = pmCourseCol; tCol = pmTokushuCol; }
    if (category === '競馬') { courseCol = keibaCourseCol; tCol = keibaTokushuCol; }
    const shops = records.filter((r) => r[`col_${courseCol}`] === courseName);
    if (!shops.length) return { amount: 0, detail: '該当店舗なし', shopCount: 0, yuukan: 0, kyori: 0, tokushu: 0, zasshi: 0 };
    const shopCount = shops.length; let tokushu = 0, yuukan = 0, kyori = 0, zasshi = 0;
    shops.forEach((s) => { if (s[`col_${tCol}`] === 'TRUE') tokushu++; if (yuukanCol >= 0 && s[`col_${yuukanCol}`] === 'TRUE') yuukan++; if (kyoriCol >= 0 && s[`col_${kyoriCol}`] === 'TRUE') kyori++; if (zasshiCol >= 0 && s[`col_${zasshiCol}`] === 'TRUE') zasshi++; });
    const amount = shopCount * 265 + yuukan * 50 + kyori * 13 + tokushu * 20 + zasshi * 80;
    return { amount, detail: `${shopCount}店×265`, shopCount, yuukan, kyori, tokushu, zasshi };
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!SESSION_SECRET) return json({ error: 'SHIFT_SESSION_SECRET 未設定' }, 500);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({} as any));
    const ym = String(body.year_month ?? '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: 'year_month (YYYY-MM) が必要です' }, 400);
    const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
    const dryRun = body.dry_run !== false; // 既定=dry_run(読取のみ)

    // 書込認証: service_role bearer or automation_config.cron_secret
    let authorized = false;
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (bearer && bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) authorized = true;
    if (!authorized && body.cron_secret) { const { data: cs } = await sb.from('automation_config').select('value').eq('key', 'cron_secret').maybeSingle(); authorized = !!(cs?.value && cs.value === String(body.cron_secret)); }
    // NexPort管理者JWT(ビューアの「変更を反映」ボタン)でも書込許可
    if (!authorized && body.auth_token) {
      try {
        const uc = createClient(Deno.env.get('SUPABASE_URL')!, ANON, { global: { headers: { Authorization: 'Bearer ' + body.auth_token } } });
        const { data: { user } } = await uc.auth.getUser();
        if (user) { const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle(); if (prof?.role === 'admin' || prof?.role === 'super_admin') authorized = true; }
      } catch (_) { /* noop */ }
    }
    if (!dryRun && !authorized) return json({ error: '書込(確定)は権限がありません。cron/管理のみ。', code: 'FORBIDDEN' }, 403);

    // ── データ取得 ──
    const token = await adminToken();
    const [ratesRes, specialRes, kwRes, shopRes] = await Promise.all([
      invApi('get_rates', token), invApi('get_special_rates', token), invApi('get_kawagoe_course_prices', token),
      fetch(`${BASE}/functions/v1/shop-master`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }).then((r) => r.json()).catch(() => ({})),
    ]);
    const invRates: any[] = ratesRes?.rates || [];
    if (!invRates.length) return json({ error: '単価マスタ取得失敗(get_rates)', detail: ratesRes?.error || '' }, 500);
    const invSpecial: any[] = specialRes?.records || [];
    const kwOld: any[] = kwRes?.old || [], kwNew: any[] = kwRes?.new || [];
    // 川越コース単価表の突合。全角数字・前後空白のゆれで引けずに 0円 で確定する事故があったため、
    // 正規化したキーで引く。引けなかった場合は黙って0円にせず kwMisses に記録して外に出す。
    const normCourse = (s: unknown) => String(s ?? '').trim()
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/[\s　]/g, '');
    const kwMap: Record<string, Map<string, any>> = {
      '旧': new Map(kwOld.map((mm: any) => [normCourse(mm.course), mm])),
      '新': new Map(kwNew.map((mm: any) => [normCourse(mm.course), mm])),
    };
    const kwMisses = new Map<string, number>(); // "パターン/コース" -> 引けなかった日数
    const shop = { headers: shopRes?.headers || [], records: shopRes?.records || [] };
    const calcKodate = makeCalcKodate(shop);

    const { data: sheetRow } = await sb.from('shift_sheet_cache').select('rows').eq('sheet_name', `${m}月シフト${y}`).maybeSingle();
    const rows2d: any[][] = (sheetRow?.rows as any[][]) || [];
    if (!rows2d.length) return json({ error: `シフト未取得: ${m}月シフト${y} が shift_sheet_cache に無い` }, 404);
    const { data: bcRow } = await sb.from('bill_conditions').select('conditions').eq('month_val', ym).maybeSingle();
    const billCond: any = bcRow?.conditions || {};

    const areaData = parseShiftRows(rows2d, y);
    // staff集約: normName -> {ymd:{am_course,pm_course}} と 主稼働area
    const staffShifts: Record<string, Record<string, { am_course: string; pm_course: string }>> = {};
    const staffAreaDays: Record<string, Record<string, number>> = {};
    for (const area of Object.keys(areaData)) {
      for (const staffName of Object.keys(areaData[area])) {
        const nk = invNormName(staffName);
        (staffShifts[nk] ||= {}); (staffAreaDays[nk] ||= {});
        for (const ymd of Object.keys(areaData[area][staffName])) {
          const { am, pm } = areaData[area][staffName][ymd];
          (staffShifts[nk][ymd] ||= { am_course: '', pm_course: '' });
          if (!isNonPaid(am)) staffShifts[nk][ymd].am_course = String(am).trim();
          if (!isNonPaid(pm)) staffShifts[nk][ymd].pm_course = String(pm).trim();
          let paid = 0; if (!isNonPaid(am)) paid++; if (!isNonPaid(pm)) paid++;
          staffAreaDays[nk][area] = (staffAreaDays[nk][area] || 0) + paid;
        }
      }
    }
    const primaryArea = (nk: string) => { let a = '', mx = 0; for (const [ar, d] of Object.entries(staffAreaDays[nk] || {})) { if (d > mx) { mx = d; a = ar; } } return a; };

    // ── 特別単価・単価ルックアップ ──
    const findSpecial = (date: string, staff: string) => { const nd = date.replace(/-/g, '/'), nn = invNormName(staff); return invSpecial.filter((s) => (s.date || '').replace(/-/g, '/') === nd && invNormName(s.name) === nn); };
    const applySpecial = (amount: number, date: string, staffName: string, isAm: boolean) => {
      const cat = isAm ? '朝刊' : '夕刊';
      const sp = findSpecial(date, staffName).filter((s) => (s.category || '').includes(cat));
      if (!sp.length) return amount;
      let rep = 0, add = 0;
      sp.forEach((s) => { const amt = Number(String(s.amount || '').replace(/,/g, '')) || 0; if (s.type === '日当') rep += amt; else if (s.type === '日当+') add += amt; });
      let na = amount; if (rep) na = rep; na += add; return na;
    };
    const lookupRate = (rate: any, dow: string, isAm: boolean, courseName: string): number => {
      if (!rate) return 0; const course = courseName || '';
      if (course.includes('庫内')) return isAm ? (Number(rate.warehouse_am) || 0) : (Number(rate.warehouse_pm) || 0);
      const dowNum = DOW.indexOf(dow);
      if (isAm) {
        const kwPattern = rate.kw_pattern || '';
        if (kwPattern && course.startsWith('川越')) {
          const found = kwMap[kwPattern]?.get(normCourse(course));
          const DK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
          const v = found ? (Number(found[DK[dowNum]]) || 0) : 0;
          if (v) return v;
          // 単価表から引けなかった。このまま下に落ちると am_weekday(川越の人は空)=0円になり、
          // 「支払漏れなのに誰も気づかない」状態になるため記録して呼び出し元へ返す。
          const key = `${kwPattern}/${course}`;
          kwMisses.set(key, (kwMisses.get(key) || 0) + 1);
        }
        const kwDays = String(rate.kw_am_daily || '').split(','); const kwMap = [6, 0, 1, 2, 3, 4, 5]; const kwP = kwDays[kwMap[dowNum]];
        if (kwP) return Number(kwP) || 0;
        if (dow === '日') return Number(rate.am_sunday) || Number(rate.am_weekend) || 0;
        if (dow === '土') return Number(rate.am_weekend) || 0;
        return Number(rate.am_weekday) || 0;
      } else {
        if (dow === '日') return Number(rate.pm_sunday) || Number(rate.pm_weekend) || 0;
        if (dow === '金' || dow === '土') return Number(rate.pm_weekend) || 0;
        return Number(rate.pm_weekday) || 0;
      }
    };
    const arr = (k: string): number[] => Array.isArray(billCond[k]) ? billCond[k] : [];
    const calcKodateAm = (course: string, day: number, dow: string) => {
      if (!course || course.includes('庫内')) return null;
      if (arr('holiday').includes(day)) return 0; if (arr('noam').includes(day)) return 0;
      const ko = calcKodate(course, '朝刊'); if (!ko.shopCount) return 0;
      const hasDok = arr('yesdokkon').includes(day) || (dow !== '月' && !arr('nodokkon').includes(day));
      const yuukan = hasDok ? (ko.yuukan || 0) : 0;
      return (ko.shopCount || 0) * 265 + yuukan * 50 + (ko.kyori || 0) * 13 + (ko.tokushu || 0) * 20 + (ko.zasshi || 0) * 80;
    };
    const calcKodatePm = (course: string, day: number, dow: string) => {
      if (!course || course.includes('庫内')) return null;
      if (arr('holiday').includes(day)) return 0; if (arr('nopm').includes(day)) return 0;
      const dowNum = DOW.indexOf(dow); const isSun = dowNum === 0; const yesKeiba = arr('yeskeiba').includes(day);
      if (isSun && !yesKeiba) return 0;
      const isKeiba = dowNum === 5 || dowNum === 6 || yesKeiba;
      const ko = calcKodate(course, isKeiba ? '競馬' : '夕刊/競馬'); if (!ko.shopCount) return 0; return ko.amount;
    };
    const calcQtyAm = (course: string, rate: any) => {
      if (!course || course.includes('庫内')) return null; const up = Number(rate.unit_price) || 0; if (!up) return 0;
      const ko = calcKodate(course, '朝刊'); if (!ko.shopCount) return 0; return up * ko.shopCount;
    };
    const calcQtyPm = (course: string, day: number, dow: string, rate: any) => {
      if (!course || course.includes('庫内')) return null; const up = Number(rate.unit_price_pm) || Number(rate.unit_price) || 0; if (!up) return 0;
      const dowNum = DOW.indexOf(dow); const isSun = dowNum === 0; const yesKeiba = arr('yeskeiba').includes(day);
      if (isSun && !yesKeiba) return 0; const isKeiba = dowNum === 5 || dowNum === 6 || yesKeiba;
      const ko = calcKodate(course, isKeiba ? '競馬' : '夕刊/競馬'); if (!ko.shopCount) return 0; return up * ko.shopCount;
    };

    // ── 1名分の明細 (admPayBuildStatement 移植) ──
    const lastDay = new Date(y, m, 0).getDate();
    const buildStatement = (rate: any) => {
      const nk = invNormName(rate.name); const dayMap = staffShifts[nk] || {};
      const isAmKodate = (rate.calc_type || '') === '個建', isPmKodate = ((rate.calc_type_pm || rate.calc_type) || '') === '個建';
      const isAmQty = (rate.calc_type || '') === '個数', isPmQty = ((rate.calc_type_pm || rate.calc_type) || '') === '個数';
      const rowsOut: any[] = []; let amSum = 0, pmSum = 0;
      for (let d = 1; d <= lastDay; d++) {
        const ymd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const date = new Date(y, m - 1, d); const dowJp = DOW[date.getDay()];
        const sh = dayMap[ymd] || { am_course: '', pm_course: '' };
        let amAmount = 0;
        if (sh.am_course) {
          const isHi = isHikitsugi(sh.am_course); const bare = isHi ? stripHikitsugi(sh.am_course) : sh.am_course;
          if (isAmKodate && !bare.includes('庫内')) { const ko = calcKodateAm(bare, d, dowJp); amAmount = ko == null ? lookupRate(rate, dowJp, true, bare) : ko; }
          else if (isAmQty && !bare.includes('庫内')) { const qt = calcQtyAm(bare, rate); amAmount = qt == null ? lookupRate(rate, dowJp, true, bare) : qt; }
          else amAmount = lookupRate(rate, dowJp, true, bare);
          if (isHi) amAmount = Math.floor(amAmount / 2);
        }
        amAmount = applySpecial(amAmount, ymd, rate.name, true);
        let pmAmount = 0;
        if (sh.pm_course) {
          const isHi = isHikitsugi(sh.pm_course); const bare = isHi ? stripHikitsugi(sh.pm_course) : sh.pm_course;
          if (isPmKodate && !bare.includes('庫内')) { const ko = calcKodatePm(bare, d, dowJp); pmAmount = ko == null ? lookupRate(rate, dowJp, false, bare) : ko; }
          else if (isPmQty && !bare.includes('庫内')) { const qt = calcQtyPm(bare, d, dowJp, rate); pmAmount = qt == null ? lookupRate(rate, dowJp, false, bare) : qt; }
          else pmAmount = lookupRate(rate, dowJp, false, bare);
          if (isHi) pmAmount = Math.floor(pmAmount / 2);
        }
        pmAmount = applySpecial(pmAmount, ymd, rate.name, false);
        amSum += amAmount; pmSum += pmAmount;
        rowsOut.push({ d: `${String(m).padStart(2, '0')}月${String(d).padStart(2, '0')}日`, ymd, dow: dowJp, am_course: sh.am_course, am: amAmount, pm_course: sh.pm_course, pm: pmAmount, total: amAmount + pmAmount });
      }
      // 🧭 プランナー手当(単価マスタ 月額)。稼働のある月のみ加算。
      const plannerAllowance = (amSum + pmSum) > 0 ? (Number(rate.planner_allowance) || 0) : 0;
      return { amSum, pmSum, plannerAllowance, grandTotal: amSum + pmSum + plannerAllowance, rows: rowsOut };
    };

    // ── 全非社員を確定 ──
    // only_staff / only_company を指定すると対象を絞れる (特定の1社・1名だけの再確定用)。
    // force と併用しても、指定外の人の確定済み明細は一切触らない。
    const onlyStaff: string[] = ([] as string[]).concat(body.only_staff ?? []).filter(Boolean).map((v: string) => invNormName(String(v)));
    const onlyCompany: string[] = ([] as string[]).concat(body.only_company ?? []).filter(Boolean).map((v: string) => coKey(String(v)));
    const isTarget = (rate: any) => {
      if (onlyStaff.length && onlyStaff.includes(invNormName(String(rate.name || '')))) return true;
      if (onlyCompany.length && onlyCompany.includes(coKey(String(rate.company || '')))) return true;
      return !onlyStaff.length && !onlyCompany.length;
    };
    const targets: any[] = []; const skipped: string[] = [];
    for (const rate of invRates) {
      if (rate.biz_type === '社員') continue;
      if (!isTarget(rate)) continue;
      let st; try { st = buildStatement(rate); } catch { st = null; }
      if (!st || !((st.rows && st.rows.some((r: any) => r.total > 0)) || st.grandTotal > 0)) { skipped.push(rate.name); continue; }
      const nk = invNormName(rate.name);
      targets.push({ staff_name: rate.name, year: y, month: m, am_sum: st.amSum, pm_sum: st.pmSum, planner_allowance: st.plannerAllowance || 0, grand_total: st.grandTotal, rows: st.rows, calc_type: rate.calc_type || null, calc_type_pm: rate.calc_type_pm || null, biz_type: rate.biz_type || null, company_name: rate.company || null, primary_area: primaryArea(nk) || null });
    }
    const summary = targets.map((t) => ({ staff_name: t.staff_name, grand_total: t.grand_total, primary_area: t.primary_area, company_name: t.company_name })).sort((a, b) => b.grand_total - a.grand_total);
    const totalAll = targets.reduce((a, t) => a + t.grand_total, 0);

    if (dryRun) {
      let debug: any = undefined;
      if (body.debug_staff) { const dk = invNormName(body.debug_staff); const t = targets.find((x) => invNormName(x.staff_name) === dk); debug = t ? { staff_name: t.staff_name, grand_total: t.grand_total, am_sum: t.am_sum, pm_sum: t.pm_sum, primary_area: t.primary_area, rows: (t.rows || []).filter((r: any) => r.total > 0) } : { note: 'not found in targets (no 稼働?)' }; }
      return json({ ok: true, mode: 'dry_run', year: y, month: m, count: targets.length, total: totalAll, skipped_count: skipped.length,
        kawagoe_rate_missing: [...kwMisses.entries()].map(([k, days]) => `${k} (${days}日分)`), summary, debug });
    }

    // finalize: reflected_at済みは保護(上書き禁止)。未反映のみ upsert。
    const force = body.force === true; // 変更を反映ボタン: 反映済みでも上書き再確定
    const { data: existing } = await sb.from('closed_pay_statements').select('staff_name, reflected_at').eq('year', y).eq('month', m);
    const locked = force ? new Set<string>() : new Set((existing ?? []).filter((r: any) => r.reflected_at).map((r: any) => String(r.staff_name)));
    // 既存行の反映日時。再確定で公開を取り消さないよう引き継ぐ。
    const prevReflected = new Map<string, string | null>(
      (existing ?? []).map((r: any) => [String(r.staff_name), r.reflected_at ?? null]),
    );
    // その月が既に公開済みか(1件でも反映済みがあれば公開済みとみなす)
    const monthPublished = (existing ?? []).some((r: any) => r.reflected_at);
    const now = new Date().toISOString();
    let saved = 0; const errs: string[] = [];

    // 🔧 電話番号の補完(2026-08-06)。closed_pay_statements.phone は NOT NULL で、明細ビューアの
    //    本人照合キーでもある。単価マスタの login_id が社員コード(lit003 等)の人は電話が空になり、
    //    NOT NULL 違反で「チャンクごと保存されない」= 自動確定が毎回 saved=0 になっていた。
    //    ① 中央マスタ staff_master、② 前月までの確定明細 の順に氏名で電話を引いて補完する。
    //    それでも取れない人だけを除外し、応答に列挙する(黙って落とさない)。
    const nk2 = (v: unknown) => invNormName(String(v ?? ''));
    // 会社名キー: 法人格・記号を落として表記ゆれを吸収(有限会社リトルキャット = リトルキャット)
    const coKey2 = (v: unknown) => invNormName(hwKanaToFw(v))
      .replace(/株式会社|有限会社|合同会社|合資会社|㈱|㈲|\(株\)|\(有\)|\(合\)|（株）|（有）|（合）/g, '')
      .replace(/[・.,'’`\-ー（）()]/g, '');
    const phoneByName = new Map<string, string>();
    const phoneByCompany = new Map<string, string>(); // 会社 → 代表(オーナー)/担当の電話
    {
      const { data: sm } = await sb.from('staff_master').select('full_name, phone, company_name, is_company_owner, is_company_contact, hidden');
      for (const r of (sm ?? []) as any[]) {
        const ph = String(r.phone ?? '').replace(/[^0-9]/g, '');
        const k = nk2(r.full_name);
        if (k && ph && !phoneByName.has(k)) phoneByName.set(k, ph);
        // 法人の枠行(人名なし・電話なし)は会社の代表/担当の電話で確定できるようにする。
        // オーナー優先(先に入れる)、居なければ担当。非表示の人は使わない。
        if (ph && r.company_name && !r.hidden && (r.is_company_owner || r.is_company_contact)) {
          const ck = coKey2(r.company_name);
          if (ck && (r.is_company_owner || !phoneByCompany.has(ck))) {
            if (r.is_company_owner || !phoneByCompany.has(ck)) phoneByCompany.set(ck, ph);
          }
        }
      }
      const { data: past } = await sb.from('closed_pay_statements').select('staff_name, phone').not('phone', 'is', null).order('year', { ascending: false }).order('month', { ascending: false }).limit(2000);
      for (const r of (past ?? []) as any[]) { const k = nk2(r.staff_name); const ph = String(r.phone ?? '').replace(/[^0-9]/g, ''); if (k && ph && !phoneByName.has(k)) phoneByName.set(k, ph); }
    }
    // 🔧 会社名の正式名寄せ(2026-08-06)。単価マスタは「TLC.ﾊﾟｰﾄﾅｰｽﾞ㈱」のような半角カナ/略称表記があり、
    //    そのまま確定明細に保存すると会計の適格請求書マスタ「TLC.パートナーズ株式会社」と照合できず、
    //    明細ビューアで適格判定が外れて消費税・登録番号が落ちる。
    //    会計「会社名の正規化設定」(company_aliases / non_company_names)を staff-master-sync と
    //    同じ3段(①別名→正式名 ②荷主/営業所はクリア ③会計マスタの正式表記へ)で適用する。
    //    ※ coKey は staff-master-sync:20 と同一定義 + NFKC が ㈱→(株) に開く分を戻す補正。
    const coKeyAcc = (v: unknown) => String(v ?? '').normalize('NFKC')
      .replace(/[\s・.,'’`-]+/g, '')
      .replace(/株式会社|\(株\)/g, '㈱').replace(/合同会社/g, '(合)').replace(/有限会社|\(有\)/g, '㈲')
      .toLowerCase();
    const BASE_NON_COMPANY = ['アスクル', 'ヤマト', 'ヤマト運輸', 'SBS', 'SBSネクサード株式会社', '東京スポーツ', '東スポ', '新聞', 'デリバリー', '配送'];
    const canonCo = new Map<string, string>();   // 会計マスタ正式表記
    const aliasCo = new Map<string, string>();   // 別名(略称/旧称) → 正式名
    const nonCo = new Set<string>();             // 会社扱いしない語(荷主/営業所)
    {
      const [ipRes, alRes, ncRes] = await Promise.all([
        sb.from('acc_invoice_partners').select('name'),
        sb.from('company_aliases').select('alias, canonical'),
        sb.from('non_company_names').select('name'),
      ]);
      for (const r of ((ipRes.data ?? []) as any[])) { const n = String(r.name ?? '').trim(); if (n) canonCo.set(coKeyAcc(n), n); }
      for (const r of ((alRes.data ?? []) as any[])) { const a = String(r.alias ?? '').trim(), c = String(r.canonical ?? '').trim(); if (a && c) aliasCo.set(coKeyAcc(a), c); }
      for (const n of [...BASE_NON_COMPANY, ...((ncRes.data ?? []) as any[]).map((r) => String(r.name ?? ''))]) { const k = coKeyAcc(n); if (k) nonCo.add(k); }
    }
    const renamedCo: string[] = [];
    const clearedCo: string[] = [];
    const toOfficialCo = (v: unknown): string | null => {
      const raw = String(v ?? '').trim(); if (!raw) return null;
      const cn = aliasCo.get(coKeyAcc(raw)) ?? raw;                       // ① 別名 → 正式名
      if (nonCo.has(coKeyAcc(cn))) { clearedCo.push(raw); return null; }  // ② 荷主/営業所はクリア
      const hit = canonCo.get(coKeyAcc(cn)) ?? cn;                        // ③ 会計マスタの正式表記へ
      if (hit !== raw) renamedCo.push(`${raw}→${hit}`);
      return hit;
    };
    const noPhone: string[] = [];
    const byCompanyUsed: string[] = [];
    const writeRows = targets
      .filter((t) => !locked.has(String(t.staff_name)))
      .map((t) => {
        // 会社名は先に正式名へ寄せる(中央マスタ staff_master も正式名で持っているので照合が通る)
        const coName = toOfficialCo(t.company_name);
        // ① 氏名で一致 ② 過去の確定明細 ③ 法人なら会社の代表/担当の電話
        let ph = phoneByName.get(nk2(t.staff_name)) ?? null;
        if (!ph && coName) {
          const co = phoneByCompany.get(coKey2(coName));
          if (co) { ph = co; byCompanyUsed.push(`${t.staff_name}(${coName})`); }
        }
        if (!ph) noPhone.push(String(t.staff_name));
        // 既に公開済みの月に後から作られた行(誤記修正での復活など)は、その場で公開する。
        // reflected_at が null のままだと明細ビューアの取引先一覧に出ず、修正した本人にも
        // 見えない(2026-07 のノアガデル・TLC5 が該当)。反映は月次cronのため翌月まで放置される。
        // まだ一度も公開していない月は従来どおり null のままにし、反映工程で解禁する。
        const prevRef = prevReflected.get(String(t.staff_name)) ?? null;
        const refAt = prevRef ?? (monthPublished ? now : null);
        return { ...t, company_name: coName, phone: ph, reflected_at: refAt, finalized_at: now, finalized_by: 'cron:finalize-shift' };
      });
    // 電話が取れない人も確定する(phone は null 可にした)。ビューアは電話で本人照合するため
    // 「本人ログインでは自分の明細を引けない」制約は残る → no_phone として応答に列挙し、登録を促す。

    for (let i = 0; i < writeRows.length; i += 100) {
      const chunk = writeRows.slice(i, i + 100);
      const { error } = await sb.from('closed_pay_statements').upsert(chunk, { onConflict: 'staff_name,year,month' });
      if (error) {
        // 1件の不良で100件が丸ごと落ちないよう、失敗したチャンクは1件ずつ入れ直す
        for (const one of chunk) {
          const { error: e1 } = await sb.from('closed_pay_statements').upsert([one], { onConflict: 'staff_name,year,month' });
          if (e1) errs.push(`${one.staff_name}: ${e1.message}`); else saved++;
        }
      } else saved += chunk.length;
    }
    // 川越コース単価表から引けなかったコースがあれば常設アラートにする。
    // 金額0で確定してしまう性質上、本人からの異議が来るまで誰も気づかないため。
    const kwMissList = [...kwMisses.entries()].map(([k, days]) => `${k} (${days}日分)`);
    if (kwMissList.length) {
      const nowA = new Date().toISOString();
      await sb.from('sm_active_alerts').upsert({
        key: `kw_course_rate_missing:${ym}`, app: 'shift-manager', kind: 'kw_course_rate_missing',
        title: `⛔ 川越コース単価が引けません (${y}年${m}月)`,
        body: `下記のコースが川越コース単価表(マスタ2 AN〜AV列)から引けず、朝刊が0円で確定しています。単価表に該当コースの行があるか確認してください。\n対象: ${kwMissList.join('、')}`,
        cnt: kwMissList.length, names: kwMissList, status: 'open', resolved_at: null, updated_at: nowA,
      }, { onConflict: 'key' }).then(() => {}, () => {}); // アラート失敗で確定自体は止めない
    } else {
      await sb.from('sm_active_alerts').update({ status: 'resolved', resolved_at: new Date().toISOString(), cnt: 0, updated_at: new Date().toISOString() })
        .eq('key', `kw_course_rate_missing:${ym}`).eq('status', 'open').then(() => {}, () => {});
    }
    return json({ ok: true, mode: 'finalize', year: y, month: m, count: targets.length, saved, locked: locked.size, total: totalAll,
      skipped_no_phone: noPhone, phone_from_company: byCompanyUsed, company_renamed: renamedCo, company_cleared: clearedCo,
      kawagoe_rate_missing: kwMissList, errors: errs });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
