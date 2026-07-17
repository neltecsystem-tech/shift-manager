import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 店舗マスタは専用スプレッドシートへ独立 (2026-06-30)。マスタ2 は旧ワークブック据え置き
// (invoice-sheet 川越単価 + 月報ワークブック内2万数式が依存するため動かさない)。
const SPREADSHEET_ID = '1KvMbiLMeUmUOiUwzcilp-6u2xzZXs68HcvtWuWqT70M'; // 店舗マスタ専用 (新)
const MASTER2_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';     // マスタ2 (旧ワークブック「月報開発中」)
const SHEET_NAME = '店舗マスタ';
const MASTER2_SHEET = 'マスタ2';
// 月初スナップショット: 請求が「月初の店舗・コース構成」で確定するまで現場がマスタを
// 自由に編集できるよう、毎月1日に店舗マスタ全行を月別タブへ凍結保存する。
const SNAP_PREFIX = '月初_';   // タブ名 例: 月初_2026-06
const SNAP_KEEP = 4;           // 直近4ヶ月分のスナップタブを保持(先月/今月+予備)
const SNAP_RE = /^月初_\d{4}-\d{2}$/;
const SUMMARY_SHEET = '月初集計'; // 4ヶ月超で実体タブを消しても残す請求店舗数の簡易履歴
const COL_END = 'AO';
const N_COLS = 41;
// AM=38 休店中(チェック), AN=39 休店開始日, AO=40 休店終了日 (休店終了日経過で cleanup-closed-shops が自動クリア)
// 列マップ (0-indexed)
// 朝刊:  F=5(course), M=12(order), N=13(time)
// 夕刊:  N=13(夕刊コース・現運用), O=14(夕刊コース名), R=17(夕刊順番), S=18(店着時間)
//   ※ list の headers では col 14=夕刊コース名 となる。col 13 の "夕刊コース" は別シート由来の表記揺れ対応
// 競馬:  T=19(course), X=23(order), Y=24(time)
// 新夕刊コース = AJ=35
const PM_COURSE_COL = 14;          // 夕刊コース名 (apply_new_pm_courses で書込先 = N列じゃなく O列)
const NEW_PM_COURSE_COL = 35;
const EDITION_COLS = [
  { name: 'am',    courseCol: 5,  orderCol: 12, timeCol: 13 },
  { name: 'pm',    courseCol: 14, orderCol: 17, timeCol: 18 },
  { name: 'keiba', courseCol: 19, orderCol: 23, timeCol: 24 },
];

const SERVICE_ACCOUNT = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!);

function b64url(data: string): string { return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: SERVICE_ACCOUNT.token_uri,
    iat: now, exp: now + 3600,
  }));
  const pemBody = SERVICE_ACCOUNT.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', binaryDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${header}.${payload}.${signature}`;
  const resp = await fetch(SERVICE_ACCOUNT.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  return (await resp.json()).access_token;
}

async function ensureExtraHeaders(token: string) {
  // AF=住所, AG=住所精度, AH=ナビ判定, AI=正式店舗名, AJ=新夕刊コース, AK=Place ID, AL=修正済み
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AO2`, { headers: { 'Authorization': `Bearer ${token}` } });
  const j = await r.json();
  const cur = (j.values?.[0] ?? []) as string[];
  const next = [
    (cur[0] || '').trim() || '住所',
    (cur[1] || '').trim() || '住所精度',
    (cur[2] || '').trim() || 'ナビ判定',
    (cur[3] || '').trim() || '正式店舗名',
    (cur[4] || '').trim() || '新夕刊コース',
    (cur[5] || '').trim() || 'Place ID',
    (cur[6] || '').trim() || '修正済み',
    (cur[7] || '').trim() || '休店中',
    (cur[8] || '').trim() || '休店開始日',
    (cur[9] || '').trim() || '休店終了日',
  ];
  const changed = next.some((v, i) => v !== (cur[i] || '').trim());
  if (changed) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AO2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [next] }),
    });
  }
}

// JST の現在の年月 (YYYY-MM)
function jstYearMonth(): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// 列インデックス → A1表記の列文字
function colLetter(idx: number): string {
  let n = idx, s = '';
  while (n >= 0) { s = String.fromCharCode((n % 26) + 65) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

// 日付文字列 → YYYY-MM-DD (空/不正は '')
function normDateYmd(s: string): string {
  if (!s) return '';
  const t = String(s).trim().replace(/\//g, '-');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// 月初スナップの「請求に使った店舗数(営業所×朝刊/夕刊/競馬)」を 月初集計 シートへ upsert。
// 実体タブ(月初_YYYY-MM)が4ヶ月超で剪定されても、この簡易集計は永久に残す。
async function writeSnapshotSummary(token: string, month: string, allRows: string[][]) {
  const header = (allRows[0] || []).map((h) => (h || '').trim());
  const idxBy = (pred: (h: string) => boolean) => header.findIndex(pred);
  const areaIdx = idxBy((h) => h.includes('営業所'));
  const amIdx = idxBy((h) => h.includes('朝刊コース'));
  let pmIdx = -1; header.forEach((h, i) => { if (h === '新夕刊コース') return; if (h.includes('夕刊コース')) pmIdx = i; });
  const keibaIdx = idxBy((h) => h.includes('競馬コース'));
  const openIdx = idxBy((h) => h.includes('開店日'));
  const codeIdx = idxBy((h) => h.includes('店舗コード'));
  const nameIdx = idxBy((h) => h.includes('店舗名') && h !== '正式店舗名');
  const monthFirst = month + '-01';
  const acc: Record<string, { am: number; pm: number; keiba: number }> = {};
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] || [];
    if (!(row[codeIdx] || row[nameIdx])) continue;
    let area = String(row[areaIdx] || '').split(',')[0].trim();
    if (!area || area.includes('納品中止')) continue;
    if (area === '池袋') area = '城北'; // 請求は城北に統合
    const od = normDateYmd(String(row[openIdx] || ''));
    if (od && od > monthFirst) continue; // 月初時点で未開店は除外(請求の isOpenOn と同じ)
    if (!acc[area]) acc[area] = { am: 0, pm: 0, keiba: 0 };
    if (amIdx >= 0 && String(row[amIdx] || '').trim()) acc[area].am++;
    if (pmIdx >= 0 && String(row[pmIdx] || '').trim()) acc[area].pm++;
    if (keibaIdx >= 0 && String(row[keibaIdx] || '').trim()) acc[area].keiba++;
  }
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const newRows: any[][] = [];
  let tAm = 0, tPm = 0, tK = 0;
  Object.keys(acc).sort().forEach((area) => {
    const a = acc[area]; tAm += a.am; tPm += a.pm; tK += a.keiba;
    newRows.push([month, area, a.am, a.pm, a.keiba, a.am + a.pm + a.keiba, stamp]);
  });
  newRows.push([month, '合計', tAm, tPm, tK, tAm + tPm + tK, stamp]);

  // 集計シート確保 + 既存(同月除く)と結合して書き戻し
  const metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`, { headers: { 'Authorization': `Bearer ${token}` } });
  const props = ((await metaResp.json()).sheets || []).map((s: any) => s.properties);
  const exists = props.find((p: any) => p.title === SUMMARY_SHEET);
  let existing: string[][] = [];
  if (!exists) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SUMMARY_SHEET, gridProperties: { rowCount: 2000, columnCount: 7 } } } }] }),
    });
  } else {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SUMMARY_SHEET)}!A2:G10000`, { headers: { 'Authorization': `Bearer ${token}` } });
    existing = (((await r.json()).values || []) as string[][]).filter((row) => row[0] && row[0] !== month);
  }
  const HEAD = ['年月', '営業所', '朝刊店舗数', '夕刊店舗数', '競馬店舗数', '合計', '記録日時'];
  const merged = [...existing, ...newRows].sort((a, b) => {
    if (a[0] !== b[0]) return String(b[0]).localeCompare(String(a[0])); // 年月 降順
    if (a[1] === '合計') return 1; if (b[1] === '合計') return -1;       // 合計は各月の末尾
    return String(a[1]).localeCompare(String(b[1]));
  });
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SUMMARY_SHEET)}!A:G:clear`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SUMMARY_SHEET)}!A1?valueInputOption=RAW`, {
    method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [HEAD, ...merged] }),
  });
  return { month, areas: Object.keys(acc).length, total: tAm + tPm + tK };
}

// 月初の訂正後にスナップから集計(月初集計)を再計算して同期
async function recomputeSnapshotSummary(token: string, month: string) {
  const tab = SNAP_PREFIX + month;
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) return;
  const rows = ((await r.json()).values || []) as string[][];
  if (rows.length < 2) return;
  await writeSnapshotSummary(token, month, rows);
}

// HH:MM (または HH:MM:SS) を分に変換。空文字なら -1。
function timeToMin(s: string): number {
  if (!s) return -1;
  const m = String(s).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// (edition, course) を 店着時間順に再採番。
// excludeRows: 既に削除予定 等で順番から除外したい行 (省略可)
async function reorderEdition(token: string, edition: { courseCol: number; orderCol: number; timeCol: number }, course: string) {
  if (!course) return { updated: 0, course };
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:${COL_END}10000`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const j = await resp.json();
  const allRows = (j.values ?? []) as string[][];
  // row 0 = ヘッダー (シート行2)。データ行 i (0-indexed from data) = シート行 i + 3
  const targets: { row_number: number; time: string; mins: number }[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] || [];
    const c = (row[edition.courseCol] || '').trim();
    if (c !== course) continue;
    const t = (row[edition.timeCol] || '').trim();
    targets.push({ row_number: i + 2, time: t, mins: timeToMin(t) });
  }
  // 店着時間昇順 (時間なしは末尾)、同時刻は row_number 昇順
  targets.sort((a, b) => {
    if (a.mins < 0 && b.mins < 0) return a.row_number - b.row_number;
    if (a.mins < 0) return 1;
    if (b.mins < 0) return -1;
    if (a.mins !== b.mins) return a.mins - b.mins;
    return a.row_number - b.row_number;
  });
  // 採番して書込 (既に正しい値なら省略)
  const orderLetter = colLetter(edition.orderCol);
  const data: any[] = [];
  for (let idx = 0; idx < targets.length; idx++) {
    const t = targets[idx];
    const newOrder = String(idx + 1);
    const currentOrder = (allRows[t.row_number - 2]?.[edition.orderCol] || '').trim();
    if (currentOrder === newOrder) continue;
    data.push({
      range: `'${SHEET_NAME}'!${orderLetter}${t.row_number}:${orderLetter}${t.row_number}`,
      values: [[newOrder]],
    });
  }
  if (data.length === 0) return { updated: 0, course, total: targets.length };
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('reorder batchUpdate failed: ' + r.status + ' ' + errText.slice(0, 300));
  }
  return { updated: data.length, course, total: targets.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const reqBody = await req.json();
    const { action, record, row_number, updates } = reqBody;
    const token = await getAccessToken();

    if (action === 'master_options') {
      const [areaResp, courseResp] = await Promise.all([
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER2_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!B3:B10`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER2_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!A3:A150`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      const areaJson = await areaResp.json();
      const courseJson = await courseResp.json();
      const areas = (areaJson.values || []).map((r: string[]) => (r[0] || '').trim()).filter(Boolean);
      const courses = (courseJson.values || []).map((r: string[]) => (r[0] || '').trim()).filter(Boolean);
      return new Response(JSON.stringify({ areas, courses }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── 月初スナップショット ──
    if (action === 'snapshot_create') {
      // 店舗マスタ全行(header=シート行2, data=行3+)を月別タブへ凍結。古いスナップは剪定。
      const month = (reqBody.month || jstYearMonth()).toString().trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return new Response(JSON.stringify({ error: 'month は YYYY-MM 形式' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      await ensureExtraHeaders(token);
      const src = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:${COL_END}10000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const allRows = ((await src.json()).values ?? []) as string[][];
      if (allRows.length < 2) {
        return new Response(JSON.stringify({ error: '店舗マスタが空' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const tab = SNAP_PREFIX + month;
      const metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`, { headers: { 'Authorization': `Bearer ${token}` } });
      const props = ((await metaResp.json()).sheets || []).map((s: any) => s.properties);
      const existing = props.find((p: any) => p.title === tab);
      const needRows = allRows.length + 10; // グリッド行数 (デフォルト1000では足りない)
      if (!existing) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab, gridProperties: { rowCount: needRows, columnCount: N_COLS } } } }] }),
        });
      } else {
        // 既存タブ: 内容クリア + グリッドを必要行数まで拡張
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A:AZ:clear`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId: existing.sheetId, gridProperties: { rowCount: needRows, columnCount: N_COLS } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }] }),
        });
      }
      // RAW で 1000行ずつ書込 (凍結なので再解釈させない)
      const CHUNK = 1000;
      for (let i = 0; i < allRows.length; i += CHUNK) {
        const block = allRows.slice(i, i + CHUNK);
        const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A${i + 1}?valueInputOption=RAW`, {
          method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: block }),
        });
        if (!r.ok) {
          const t = await r.text();
          return new Response(JSON.stringify({ error: 'snapshot write failed: ' + r.status + ' ' + t.slice(0, 300), wrote_until: i }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
      // 集計(請求店舗数)を 月初集計 シートへ記録 (実体タブが剪定されても残る)
      let summary: any = null, summaryError: string | null = null;
      try { summary = await writeSnapshotSummary(token, month, allRows); }
      catch (e: any) { summaryError = e.message; }

      // 剪定: 月初_ タブを月降順、SNAP_KEEP を超える古いものを削除
      const snapTitles = props.filter((p: any) => SNAP_RE.test(p.title)).map((p: any) => p.title);
      if (!snapTitles.includes(tab)) snapTitles.push(tab);
      snapTitles.sort().reverse();
      const toDelete = snapTitles.slice(SNAP_KEEP);
      const delReqs = toDelete.map((dt: string) => {
        const p = props.find((x: any) => x.title === dt);
        return p ? { deleteSheet: { sheetId: p.sheetId } } : null;
      }).filter(Boolean);
      if (delReqs.length) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: delReqs }),
        });
      }
      return new Response(JSON.stringify({ success: true, month, tab, rows: allRows.length - 1, pruned: toDelete, summary, summaryError }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'snapshot_summary_read') {
      // 月初集計シート(請求店舗数の永久履歴)を返す
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SUMMARY_SHEET)}!A1:G10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) {
        return new Response(JSON.stringify({ header: [], rows: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const vals = ((await r.json()).values || []) as string[][];
      return new Response(JSON.stringify({ header: vals[0] || [], rows: vals.slice(1) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'inspect_table') {
      const meta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets(properties(sheetId,title),tables)`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
      const sh = (meta.sheets || []).find((s: any) => s.properties?.title === SHEET_NAME);
      return new Response(JSON.stringify({ sheetId: sh?.properties?.sheetId, tables: sh?.tables || [] }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'fix_validation') {
      // 移行でコピーされた営業所/コースのドロップダウンが #REF! になったのを修正。
      // マスタ2(旧)の選択肢を新SSの「選択肢」タブへ写し、その範囲を参照させる。
      const [aResp, cResp] = await Promise.all([
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER2_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!B3:B10`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER2_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!A3:A150`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      const areas = (((await aResp.json()).values || []) as string[][]).map((r) => (r[0] || '').trim()).filter(Boolean);
      const courses = (((await cResp.json()).values || []) as string[][]).map((r) => (r[0] || '').trim()).filter(Boolean);
      const meta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title,gridProperties)`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
      const props = (meta.sheets || []).map((s: any) => s.properties);
      const masterSheet = props.find((p: any) => p.title === SHEET_NAME);
      if (!masterSheet) return new Response(JSON.stringify({ error: 'master sheet not found' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const CHOICES = '選択肢';
      let choices = props.find((p: any) => p.title === CHOICES);
      if (!choices) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CHOICES, gridProperties: { rowCount: 300, columnCount: 2 } } } }] }),
        });
      }
      // 選択肢タブへ書込 (A=営業所, B=コース)
      const maxLen = Math.max(areas.length, courses.length);
      const vals: any[][] = [['営業所', 'コース']];
      for (let i = 0; i < maxLen; i++) vals.push([areas[i] || '', courses[i] || '']);
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CHOICES)}!A1?valueInputOption=RAW`, {
        method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: vals }),
      });
      // 店舗マスタはテーブル(表_)で列に型がある→ updateTable で列の入力規則を直す
      const tmeta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets(properties(title),tables(tableId,range,columnProperties))`, { headers: { 'Authorization': `Bearer ${token}` } })).json();
      const tsh = (tmeta.sheets || []).find((s: any) => s.properties?.title === SHEET_NAME);
      const table = (tsh?.tables || []).find((t: any) => t.range && t.range.startColumnIndex <= 1 && t.range.endColumnIndex > 1) || (tsh?.tables || [])[0];
      if (!table) return new Response(JSON.stringify({ error: 'table not found on 店舗マスタ' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const rangeFor: Record<number, string> = {
        1: `='${CHOICES}'!$A$2:$A$50`,    // 営業所
        5: `='${CHOICES}'!$B$2:$B$300`,   // 朝刊コース名
        14: `='${CHOICES}'!$B$2:$B$300`,  // 夕刊コース名
        19: `='${CHOICES}'!$B$2:$B$300`,  // 競馬コース名
      };
      // 既存の columnProperties を保全しつつ、対象列だけ dataValidationRule を差し替え
      const colProps = (table.columnProperties || []).map((cp: any) => {
        const ci = cp.columnIndex || 0;
        if (rangeFor[ci]) {
          return { ...cp, columnIndex: ci, columnType: 'DROPDOWN', dataValidationRule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: rangeFor[ci] }] } } };
        }
        return cp;
      });
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ updateTable: { table: { tableId: table.tableId, columnProperties: colProps }, fields: 'columnProperties' } }] }),
      });
      if (!r.ok) { const t = await r.text(); return new Response(JSON.stringify({ error: 'updateTable failed: ' + r.status + ' ' + t.slice(0, 400) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
      return new Response(JSON.stringify({ success: true, areas: areas.length, courses: courses.length, tableId: table.tableId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'snapshot_update_cells') {
      // 月初の訂正: スナップの指定店舗(店舗コード一致)のセルを更新 (col_index指定)
      const month = (reqBody.month || '').toString().trim();
      const ups = (reqBody.updates || []) as any[];
      if (!/^\d{4}-\d{2}$/.test(month)) return new Response(JSON.stringify({ error: 'month は YYYY-MM' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const tab = SNAP_PREFIX + month;
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) return new Response(JSON.stringify({ error: 'snapshot not found', month }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const rows = ((await r.json()).values || []) as string[][];
      const rowByCode = new Map<string, number>(); // header=row1, data=row2+
      for (let i = 1; i < rows.length; i++) { const c = String((rows[i] || [])[2] || '').trim(); if (c && !rowByCode.has(c)) rowByCode.set(c, i + 1); }
      const data: any[] = []; let matched = 0; const notFound: string[] = [];
      for (const u of ups) {
        const sr = rowByCode.get(String(u.code || '').trim());
        if (!sr) { notFound.push(String(u.code || '')); continue; }
        const letter = colLetter(Number(u.col_index));
        data.push({ range: `'${tab}'!${letter}${sr}:${letter}${sr}`, values: [[u.value ?? '']] });
        matched++;
      }
      if (data.length) {
        const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        });
        if (!up.ok) { const t = await up.text(); return new Response(JSON.stringify({ error: 'update failed: ' + up.status + ' ' + t.slice(0, 200) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
        try { await recomputeSnapshotSummary(token, month); } catch (_) { /* 集計同期は致命的でない */ }
      }
      return new Response(JSON.stringify({ success: true, matched, notFound }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'snapshot_sync_store') {
      // 月初の訂正: 現行店舗マスタの該当店(店舗コード)を、月初スナップへ反映(無ければ追加/あれば上書き)
      const month = (reqBody.month || '').toString().trim();
      const codes = ((reqBody.codes || []) as any[]).map((c) => String(c || '').trim()).filter(Boolean);
      if (!/^\d{4}-\d{2}$/.test(month)) return new Response(JSON.stringify({ error: 'month は YYYY-MM' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const tab = SNAP_PREFIX + month;
      const lr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      const liveRows = ((await lr.json()).values || []) as string[][];
      const liveByCode = new Map<string, string[]>();
      for (let i = 1; i < liveRows.length; i++) { const row = liveRows[i] || []; const c = String(row[2] || '').trim(); if (c) liveByCode.set(c, row); }
      const sr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!sr.ok) return new Response(JSON.stringify({ error: 'snapshot not found', month }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const snapRows = ((await sr.json()).values || []) as string[][];
      const snapRowByCode = new Map<string, number>();
      for (let i = 1; i < snapRows.length; i++) { const c = String((snapRows[i] || [])[2] || '').trim(); if (c) snapRowByCode.set(c, i + 1); }
      const data: any[] = []; const appends: any[] = []; let updated = 0, appended = 0; const missingInLive: string[] = [];
      for (const code of codes) {
        const lrow = liveByCode.get(code);
        if (!lrow) { missingInLive.push(code); continue; }
        const full = [...lrow]; while (full.length < N_COLS) full.push(''); const rec = full.slice(0, N_COLS);
        const srow = snapRowByCode.get(code);
        if (srow) { data.push({ range: `'${tab}'!A${srow}:${COL_END}${srow}`, values: [rec] }); updated++; }
        else { appends.push(rec); appended++; }
      }
      if (data.length) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        });
      }
      if (appends.length) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`'${tab}'!A1:${COL_END}1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: appends }),
        });
      }
      if (updated || appended) { try { await recomputeSnapshotSummary(token, month); } catch (_) { /* 集計同期は致命的でない */ } }
      return new Response(JSON.stringify({ success: true, updated, appended, missingInLive }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'snapshot_remove_store') {
      // 月初の訂正: 月初に居るべきでない店をスナップから除外(行を空に=請求対象外)
      const month = (reqBody.month || '').toString().trim();
      const codes = ((reqBody.codes || []) as any[]).map((c) => String(c || '').trim()).filter(Boolean);
      if (!/^\d{4}-\d{2}$/.test(month)) return new Response(JSON.stringify({ error: 'month は YYYY-MM' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const tab = SNAP_PREFIX + month;
      const sr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!sr.ok) return new Response(JSON.stringify({ error: 'snapshot not found', month }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const snapRows = ((await sr.json()).values || []) as string[][];
      const rowByCode = new Map<string, number>();
      for (let i = 1; i < snapRows.length; i++) { const c = String((snapRows[i] || [])[2] || '').trim(); if (c && !rowByCode.has(c)) rowByCode.set(c, i + 1); }
      const data: any[] = []; let removed = 0; const notFound: string[] = [];
      for (const code of codes) { const r = rowByCode.get(code); if (!r) { notFound.push(code); continue; } data.push({ range: `'${tab}'!A${r}:${COL_END}${r}`, values: [new Array(N_COLS).fill('')] }); removed++; }
      if (data.length) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }),
        });
        try { await recomputeSnapshotSummary(token, month); } catch (_) { /* 集計同期は致命的でない */ }
      }
      return new Response(JSON.stringify({ success: true, removed, notFound }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'snapshot_list') {
      const metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties.title`, { headers: { 'Authorization': `Bearer ${token}` } });
      const months = ((await metaResp.json()).sheets || [])
        .map((s: any) => s.properties.title)
        .filter((t: string) => SNAP_RE.test(t))
        .map((t: string) => t.slice(SNAP_PREFIX.length))
        .sort().reverse();
      return new Response(JSON.stringify({ months }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'snapshot_read') {
      // list と同形 {records, headers} を返す (フロントが list と差し替え可能に)
      const month = (reqBody.month || '').toString().trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return new Response(JSON.stringify({ error: 'month は YYYY-MM 形式' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const tab = SNAP_PREFIX + month;
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: 'snapshot not found', month, snapshot: false }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const allRows = ((await resp.json()).values ?? []) as string[][];
      if (allRows.length < 2) {
        return new Response(JSON.stringify({ records: [], headers: [], month, snapshot: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const headers = allRows[0].map((h: string) => (h || '').trim());
      while (headers.length < N_COLS) headers.push('');
      const records = allRows.slice(1).map((row: string[], i: number) => {
        const obj: any = { row_number: i + 2 };
        headers.forEach((_: string, j: number) => { obj[`col_${j}`] = row[j] ?? ''; });
        return obj;
      }).filter((r: any) => r.col_1 || r.col_2 || r.col_3);
      return new Response(JSON.stringify({ records, headers, month, snapshot: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'snapshot_purge_course') {
      // 月初スナップ(月初_YYYY-MM)の コース列(朝刊/夕刊/競馬/新夕刊)から、指定コース値のセルだけを空欄化する。
      // 他のセル(突合で修正した内容含む)は一切変更しない。dry_run で件数プレビュー可。
      const month = (reqBody.month || '').toString().trim();
      const courses = Array.isArray(reqBody.courses) ? reqBody.courses.map((c: any) => String(c).trim()).filter(Boolean) : [];
      const dryRun = !!reqBody.dry_run;
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return new Response(JSON.stringify({ error: 'month は YYYY-MM 形式' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (!courses.length) {
        return new Response(JSON.stringify({ error: 'courses (配列) が必要' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const tab = SNAP_PREFIX + month;
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:${COL_END}10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: 'snapshot not found', month }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const allRows = ((await resp.json()).values ?? []) as string[][];
      if (allRows.length < 2) {
        return new Response(JSON.stringify({ error: 'snapshot が空' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const header = (allRows[0] || []).map((h) => (h || '').trim());
      const courseCols = header.map((h, i) => ({ h, i })).filter((x) => x.h.includes('コース')).map((x) => x.i);
      const purge = new Set(courses);
      const cleared: Record<string, number> = {}; // 列名 -> 件数
      let total = 0;
      for (let r = 1; r < allRows.length; r++) {
        const row = allRows[r] || [];
        for (const ci of courseCols) {
          const v = (row[ci] || '').toString().trim();
          if (purge.has(v)) {
            cleared[header[ci]] = (cleared[header[ci]] || 0) + 1;
            total++;
            if (!dryRun) row[ci] = '';
          }
        }
      }
      if (dryRun) {
        return new Response(JSON.stringify({ dry_run: true, month, courses, target_columns: courseCols.map((i) => header[i]), total, cleared }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      // 書き戻し (RAW, 1000行ずつ。行数は不変なのでそのまま上書き)
      const CHUNK = 1000;
      for (let i = 0; i < allRows.length; i += CHUNK) {
        const block = allRows.slice(i, i + CHUNK);
        const w = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A${i + 1}?valueInputOption=RAW`, {
          method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: block }),
        });
        if (!w.ok) {
          return new Response(JSON.stringify({ error: 'write failed: ' + w.status + ' ' + (await w.text()).slice(0, 200), wrote_until: i }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
      return new Response(JSON.stringify({ success: true, month, courses, total, cleared }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'bulk_lock_gps') {
      // 緯度経度が入っている全行を 修正済み(AL=TRUE) にする一括ロック。既にTRUEはスキップ。
      await ensureExtraHeaders(token);
      // AD=緯度(29), AE=経度(30) ... AL=修正済み(37)。AD3:AL10000 を取得 (index 0=AD)
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AD3:AL10000`, { headers: { 'Authorization': `Bearer ${token}` } });
      const rows = ((await resp.json()).values || []) as string[][];
      const data: any[] = [];
      let scanned = 0;
      rows.forEach((row: string[], i: number) => {
        const lat = parseFloat((row[0] || '').toString());
        const lng = parseFloat((row[1] || '').toString());
        const hasLL = isFinite(lat) && isFinite(lng) && lat !== 0 && lng !== 0;
        if (!hasLL) return;
        scanned++;
        const curLock = (row[8] || '').toString().trim().toUpperCase();
        if (curLock === 'TRUE') return; // 既にロック済み
        const rowNum = i + 3;
        data.push({ range: `'${SHEET_NAME}'!AL${rowNum}`, values: [['TRUE']] });
      });
      if (data.length > 0) {
        const up = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
        });
        if (!up.ok) {
          const errText = await up.text();
          return new Response(JSON.stringify({ error: 'bulk_lock_gps failed (' + up.status + '): ' + errText.slice(0, 300) }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ success: true, locked: data.length, gps_rows: scanned }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'add_course') {
      // マスタ2 A列(コース候補)へ新コースを追記。朝刊/夕刊/競馬 共通の候補リスト。
      const course = ((record?.course ?? reqBody.course) || '').toString().trim();
      if (!course) {
        return new Response(JSON.stringify({ error: 'course required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const curResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER2_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!A3:A150`, { headers: { 'Authorization': `Bearer ${token}` } });
      const curRows = ((await curResp.json()).values || []) as string[][];
      const existing = curRows.map((r: string[]) => (r[0] || '').trim());
      if (existing.some((c: string) => c === course)) {
        return new Response(JSON.stringify({ success: true, duplicate: true, courses: existing.filter(Boolean) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const targetRow = 3 + existing.length; // 既存の末尾の次の行へ
      if (targetRow > 150) {
        return new Response(JSON.stringify({ error: 'コース候補が上限(148件)に達しています' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const putRange = encodeURIComponent(`'${MASTER2_SHEET}'!A${targetRow}`);
      const putResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER2_ID}/values/${putRange}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[course]] }),
      });
      if (!putResp.ok) {
        const errText = await putResp.text();
        return new Response(JSON.stringify({ error: 'add_course failed (' + putResp.status + '): ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, course, courses: [...existing.filter(Boolean), course] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'list') {
      await ensureExtraHeaders(token);
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:${COL_END}10000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(JSON.stringify({ error: 'Sheets API error: ' + resp.status + ' ' + errText.slice(0, 200) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const result = await resp.json();
      const allRows = result.values ?? [];
      if (allRows.length < 2) {
        return new Response(JSON.stringify({ records: [], headers: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const headers = allRows[0].map((h: string) => (h || '').trim());
      while (headers.length < N_COLS) headers.push('');
      if (!headers[29]) headers[29] = '緯度';
      if (!headers[30]) headers[30] = '経度';
      if (!headers[31]) headers[31] = '住所';
      if (!headers[32]) headers[32] = '住所精度';
      if (!headers[33]) headers[33] = 'ナビ判定';
      if (!headers[34]) headers[34] = '正式店舗名';
      if (!headers[37]) headers[37] = '修正済み';
      if (!headers[38]) headers[38] = '休店中';
      if (!headers[39]) headers[39] = '休店開始日';
      if (!headers[40]) headers[40] = '休店終了日';
      const records = allRows.slice(1).map((row: string[], i: number) => {
        const obj: any = { row_number: i + 3 };
        headers.forEach((_: string, j: number) => {
          obj[`col_${j}`] = row[j] ?? '';
        });
        return obj;
      }).filter((r: any) => r.col_1 || r.col_2 || r.col_3);

      return new Response(JSON.stringify({ records, headers }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } else if (action === 'update') {
      if (!row_number || !record) {
        return new Response(JSON.stringify({ error: 'row_number and record required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const rowResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A${row_number}:${COL_END}${row_number}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const rowResult = await rowResp.json();
      const currentRow = (rowResult.values?.[0] ?? []) as string[];
      while (currentRow.length < N_COLS) currentRow.push('');
      // 更新前のコース値を退避 (コース変更時に旧コースも再採番するため)
      const oldCourses = EDITION_COLS.map(e => ({ name: e.name, oldCourse: (currentRow[e.courseCol] || '').trim() }));
      Object.entries(record).forEach(([key, val]) => {
        const m = key.match(/^col_(\d+)$/);
        if (m) currentRow[parseInt(m[1])] = val as string;
      });
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A${row_number}:${COL_END}${row_number}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [currentRow] }),
      });
      // 再採番: コースまたは店着時間が変更された editions
      const reorderResults: any[] = [];
      for (const ed of EDITION_COLS) {
        const courseChanged = (`col_${ed.courseCol}` in record);
        const timeChanged = (`col_${ed.timeCol}` in record);
        if (!courseChanged && !timeChanged) continue;
        const newCourse = (currentRow[ed.courseCol] || '').trim();
        const old = oldCourses.find(o => o.name === ed.name)!.oldCourse;
        const coursesToReorder = new Set<string>();
        if (newCourse) coursesToReorder.add(newCourse);
        if (courseChanged && old && old !== newCourse) coursesToReorder.add(old);
        for (const c of coursesToReorder) {
          const r = await reorderEdition(token, ed, c);
          reorderResults.push({ edition: ed.name, ...r });
        }
      }
      return new Response(JSON.stringify({ success: true, reorder: reorderResults }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } else if (action === 'add') {
      if (!record) {
        return new Response(JSON.stringify({ error: 'record required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const row = new Array(N_COLS).fill('');
      Object.entries(record).forEach(([key, val]) => {
        const m = key.match(/^col_(\d+)$/);
        if (m) row[parseInt(m[1])] = val as string;
      });
      // append API needs the sheet name single-quoted in the range when it contains non-ASCII
      const appendRange = encodeURIComponent(`'${SHEET_NAME}'!A2:${COL_END}2`);
      const appendResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      });
      if (!appendResp.ok) {
        const errText = await appendResp.text();
        return new Response(JSON.stringify({ error: 'Sheets append failed (' + appendResp.status + '): ' + errText.slice(0, 500) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const appendResult = await appendResp.json().catch(() => ({}));
      // 再採番: 新店が持つコース+時間 の組み合わせ
      const reorderResults: any[] = [];
      for (const ed of EDITION_COLS) {
        const course = (row[ed.courseCol] || '').trim();
        const time = (row[ed.timeCol] || '').trim();
        if (!course || !time) continue;
        const r = await reorderEdition(token, ed, course);
        reorderResults.push({ edition: ed.name, ...r });
      }
      return new Response(JSON.stringify({ success: true, updates: appendResult.updates ?? null, reorder: reorderResults }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'bulk_add') {
      // 新店CSV一括登録: records[] を一度に追加し、影響する(区分,コース)を1回ずつ店着時間順に採番
      const records = reqBody.records;
      if (!Array.isArray(records) || records.length === 0) {
        return new Response(JSON.stringify({ error: 'records array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (records.length > 1000) {
        return new Response(JSON.stringify({ error: '一度に登録できるのは1000件までです' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const rows = records.map((rec: any) => {
        const row = new Array(N_COLS).fill('');
        Object.entries(rec).forEach(([key, val]) => { const m = key.match(/^col_(\d+)$/); if (m) row[parseInt(m[1])] = val as string; });
        return row;
      });
      const appendRange = encodeURIComponent(`'${SHEET_NAME}'!A2:${COL_END}2`);
      const appendResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows }),
      });
      if (!appendResp.ok) {
        const errText = await appendResp.text();
        return new Response(JSON.stringify({ error: 'bulk append failed (' + appendResp.status + '): ' + errText.slice(0, 400) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      // 影響する (edition, course) を集めて1回ずつ再採番
      const pairs = new Set<string>();
      for (const row of rows) {
        for (const ed of EDITION_COLS) {
          const course = (row[ed.courseCol] || '').trim();
          const time = (row[ed.timeCol] || '').trim();
          if (course && time) pairs.add(ed.name + '\t' + course);
        }
      }
      let reordered = 0;
      for (const p of pairs) {
        const [name, course] = p.split('\t');
        const ed = EDITION_COLS.find((e) => e.name === name)!;
        await reorderEdition(token, ed, course);
        reordered++;
      }
      return new Response(JSON.stringify({ success: true, added: rows.length, reordered }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'batch_update_latlng') {
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'updates array required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureExtraHeaders(token);
      const data: any[] = [];
      for (const u of updates) {
        if (!u.row_number) continue;
        data.push({
          range: `'${SHEET_NAME}'!AD${u.row_number}:AE${u.row_number}`,
          values: [[u.lat ?? '', u.lng ?? '']],
        });
        if (u.accuracy) {
          data.push({
            range: `'${SHEET_NAME}'!AG${u.row_number}:AG${u.row_number}`,
            values: [[u.accuracy]],
          });
        }
      }
      if (data.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: updates.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'batch_update_addr') {
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'updates array required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureExtraHeaders(token);
      const data: any[] = [];
      for (const u of updates) {
        if (!u.row_number) continue;
        data.push({
          range: `'${SHEET_NAME}'!AF${u.row_number}:AF${u.row_number}`,
          values: [[u.addr ?? '']],
        });
        if (u.accuracy) {
          data.push({
            range: `'${SHEET_NAME}'!AG${u.row_number}:AG${u.row_number}`,
            values: [[u.accuracy]],
          });
        }
      }
      if (data.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: updates.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'batch_update_official') {
      // 正式店舗名(AI列/col34) だけを行番号指定で一括書き込み。updates=[{row_number, official}]
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'updates array required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureExtraHeaders(token);
      const data: any[] = [];
      for (const u of updates) {
        if (!u.row_number) continue;
        data.push({
          range: `'${SHEET_NAME}'!AI${u.row_number}:AI${u.row_number}`,
          values: [[u.official ?? '']],
        });
      }
      if (data.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: data.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'batch_update_verify') {
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'updates array required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureExtraHeaders(token);
      const data: any[] = [];
      for (const u of updates) {
        if (!u.row_number) continue;
        data.push({
          range: `'${SHEET_NAME}'!AH${u.row_number}:AH${u.row_number}`,
          values: [[u.verdict ?? '']],
        });
      }
      if (data.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: updates.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'apply_new_pm_courses') {
      // 新夕刊コース(AJ) を 夕刊コース名(O) に反映し、AJ をクリア
      // dry_run:true ならプレビューだけ返す
      await ensureExtraHeaders(token);
      const listResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:${COL_END}10000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const lj = await listResp.json();
      const allRows = (lj.values ?? []) as string[][];
      // row 0 = ヘッダー (シート行2)、row 1+ = データ (シート行3+)
      const targets: { row_number: number; old: string; nw: string; name: string }[] = [];
      for (let i = 1; i < allRows.length; i++) {
        const row = allRows[i] || [];
        const nw = (row[NEW_PM_COURSE_COL] || '').trim();
        if (!nw) continue;
        const old = (row[PM_COURSE_COL] || '').trim();
        const name = (row[3] || '').trim();
        targets.push({ row_number: i + 2, old, nw, name });
      }
      if (reqBody.dry_run) {
        return new Response(JSON.stringify({ success: true, targets }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (targets.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0, targets: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const data: any[] = [];
      for (const t of targets) {
        // O列 (夕刊コース名) に新値を書く
        data.push({
          range: `'${SHEET_NAME}'!O${t.row_number}:O${t.row_number}`,
          values: [[t.nw]],
        });
        // AJ列 (新夕刊コース) をクリア
        data.push({
          range: `'${SHEET_NAME}'!AJ${t.row_number}:AJ${t.row_number}`,
          values: [['']],
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: targets.length, targets }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'batch_update_cells') {
      // 任意の (row_number, col_index, value) を一括更新する汎用 API
      // updates: [{ row_number: number, col_index: number, value: string }]
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'updates array required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const colLetter = (idx: number): string => {
        let n = idx, s = '';
        while (n >= 0) { s = String.fromCharCode((n % 26) + 65) + s; n = Math.floor(n / 26) - 1; }
        return s;
      };
      const data: any[] = [];
      for (const u of updates) {
        if (!u.row_number || u.col_index == null) continue;
        const letter = colLetter(Number(u.col_index));
        data.push({
          range: `'${SHEET_NAME}'!${letter}${u.row_number}:${letter}${u.row_number}`,
          values: [[u.value ?? '']],
        });
      }
      if (data.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: data.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'batch_update_official_name') {
      if (!Array.isArray(updates) || updates.length === 0) {
        return new Response(JSON.stringify({ error: 'updates array required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureExtraHeaders(token);
      const data: any[] = [];
      for (const u of updates) {
        if (!u.row_number) continue;
        data.push({
          range: `'${SHEET_NAME}'!AI${u.row_number}:AI${u.row_number}`,
          values: [[u.official_name ?? '']],
        });
      }
      if (data.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const batchResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
      if (!batchResp.ok) {
        const errText = await batchResp.text();
        return new Response(JSON.stringify({ error: 'batchUpdate failed: ' + batchResp.status + ' ' + errText.slice(0, 300) }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, updated: updates.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } else if (action === 'create_place_id_helper_tab') {
      // 「PlaceID未取得」タブを作り、Place ID が空の店舗 (lat/lng あり・納品中止/最終納品日なし) を並べる
      const TAB_NAME = 'PlaceID未取得';
      // 1) 既存タブの sheetId 取得
      const metaResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const meta = await metaResp.json();
      const existing = (meta.sheets || []).find((s: any) => s.properties?.title === TAB_NAME);
      // 2) なければ作成
      if (!existing) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB_NAME } } }] }),
        });
      } else {
        // 既存内容をクリア
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(TAB_NAME)}!A:Z:clear`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
      }
      // 3) master 全行取得
      await ensureExtraHeaders(token);
      const listResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A2:${COL_END}10000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const lj = await listResp.json();
      const allRows = (lj.values ?? []) as string[][];
      const headersRow = allRows[0] || [];
      // 列特定 (master headers ベース)
      const findCol = (h: string) => headersRow.findIndex((x) => x === h || (x || '').includes(h));
      const codeIdx = findCol('店舗コード');
      const nameIdx = findCol('店舗名');
      const areaIdx = findCol('営業所');
      const addrIdx = findCol('住所');
      const latIdx = headersRow.findIndex((x) => x === '緯度');
      const lngIdx = headersRow.findIndex((x) => x === '経度');
      const placeIdIdx = headersRow.findIndex((x) => x === 'Place ID');
      const lastDelIdx = findCol('最終納品日');
      const targets: { row: number; code: string; name: string; area: string; addr: string; lat: string; lng: string }[] = [];
      for (let i = 1; i < allRows.length; i++) {
        const row = allRows[i] || [];
        const lat = (row[latIdx] || '').trim();
        const lng = (row[lngIdx] || '').trim();
        if (!lat || !lng) continue;
        const pid = (row[placeIdIdx] || '').trim();
        if (pid) continue;
        const area = (row[areaIdx] || '').trim();
        if (area.includes('納品中止')) continue;
        const lastDel = lastDelIdx >= 0 ? (row[lastDelIdx] || '').trim() : '';
        if (lastDel) continue;
        targets.push({
          row: i + 2,
          code: row[codeIdx] || '',
          name: row[nameIdx] || '',
          area,
          addr: row[addrIdx] || '',
          lat, lng,
        });
      }
      // 4) シート書込 (ヘッダー + 24 行)
      const sheetValues: any[][] = [
        ['行番号', '店舗コード', '店舗名', '営業所', '住所', '緯度', '経度', '🔍 検索リンク', '📍 GPS位置', 'Place ID または Google Maps URL を貼る', '反映状態'],
      ];
      for (const t of targets) {
        const q = encodeURIComponent(`${t.name} ${t.addr}`);
        const searchUrl = `https://www.google.com/maps/search/?api=1&query=${q}`;
        const gpsUrl = `https://www.google.com/maps/search/?api=1&query=${t.lat},${t.lng}`;
        // HYPERLINK 式にして「🔍 検索」「📍 GPS」とクリック可能リンク表示
        // ダブルクオート対策で式内は2重化
        const searchFormula = `=HYPERLINK("${searchUrl.replace(/"/g, '""')}","🔍 名前で検索")`;
        const gpsFormula = `=HYPERLINK("${gpsUrl.replace(/"/g, '""')}","📍 GPS位置")`;
        sheetValues.push([t.row, t.code, t.name, t.area, t.addr, t.lat, t.lng, searchFormula, gpsFormula, '', '']);
      }
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(TAB_NAME)}!A1?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: sheetValues }),
      });
      const tabUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=auto#gid=auto`;
      return new Response(JSON.stringify({ success: true, count: targets.length, tab: TAB_NAME, url: tabUrl }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } else if (action === 'apply_place_id_helper_tab') {
      // 「PlaceID未取得」タブの J列 から Place ID/URL を読み取り master AK列 に反映
      // J列の中身:
      //   1) ChIJ... 直接   → そのまま使う
      //   2) https://maps.app.goo.gl/xxx  → リダイレクト先を取得して URL パース
      //   3) https://www.google.com/maps/place/NAME/@LAT,LNG/... → Find Place From Text API で Place ID 取得
      const TAB_NAME = 'PlaceID未取得';
      // Geocoding/Places API キー (フロントエンドにも公開済み、 ドメイン制限&API制限あり)
      const apiKey = 'AIzaSyBWWZHRXPfqCc62boKSRbsEG4ihO2mYl2A';
      const resp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(TAB_NAME)}!A2:K500`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const j = await resp.json();
      const rows = (j.values || []) as string[][];
      const extractChiJ = (text: string): string | null => {
        const m = (text || '').match(/(Ch[A-Za-z0-9_-]{20,})/);
        return m ? m[1] : null;
      };
      // 短縮URL展開
      const resolveShortUrl = async (url: string): Promise<string> => {
        try {
          const r = await fetch(url, { method: 'GET', redirect: 'follow' });
          return r.url;
        } catch { return url; }
      };
      // /maps/place/NAME/@LAT,LNG パース
      const parseMapsUrl = (url: string): { name?: string; lat?: number; lng?: number } => {
        const out: any = {};
        const mn = url.match(/\/maps\/place\/([^/@]+)/);
        if (mn) out.name = decodeURIComponent(mn[1]).replace(/\+/g, ' ');
        const ml = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (ml) { out.lat = parseFloat(ml[1]); out.lng = parseFloat(ml[2]); }
        return out;
      };
      // Places API (New) Text Search で Place ID 取得
      const findPlaceId = async (name: string, lat?: number, lng?: number): Promise<string | null> => {
        if (!apiKey) return null;
        const body: any = { textQuery: name, languageCode: 'ja', maxResultCount: 5 };
        if (lat != null && lng != null) {
          body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 2000 } };
        }
        const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.location',
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) return null;
        const jj = await r.json();
        const places = jj.places || [];
        if (!places.length) return null;
        // locationBias 内で最も近いものを優先 (距離計算)
        if (lat != null && lng != null) {
          places.sort((a: any, b: any) => {
            const da = Math.hypot((a.location?.latitude || 0) - lat, (a.location?.longitude || 0) - lng);
            const db = Math.hypot((b.location?.latitude || 0) - lat, (b.location?.longitude || 0) - lng);
            return da - db;
          });
        }
        return places[0].id || null;
      };
      // タブ自身のデータから店舗名/緯度経度を引く (C列=店舗名, F列=緯度, G列=経度)
      const tabShopByRow: Record<number, { name: string; lat: number; lng: number }> = {};
      for (const row of rows) {
        const mr = parseInt(String(row[0] || '').trim(), 10);
        if (!mr) continue;
        tabShopByRow[mr] = {
          name: String(row[2] || '').trim(),
          lat: parseFloat(String(row[5] || '')),
          lng: parseFloat(String(row[6] || '')),
        };
      }
      const updates: any[] = [];
      const results: any[] = [];
      for (const row of rows) {
        const masterRow = parseInt(String(row[0] || '').trim(), 10);
        if (!masterRow) continue;
        const pasted = String(row[9] || '').trim();
        if (!pasted) continue;
        // 1) ChIJ 直接
        let pid = extractChiJ(pasted);
        let method = pid ? 'direct' : '';
        // 2) URL の場合
        if (!pid && /^https?:\/\//.test(pasted)) {
          let url = pasted;
          if (url.includes('maps.app.goo.gl') || url.includes('goo.gl/maps')) {
            url = await resolveShortUrl(url);
            pid = extractChiJ(url);
            method = pid ? 'short_url' : '';
          }
          if (!pid) {
            const p = parseMapsUrl(url);
            // /maps/search/?...&query=NAME 形式も対応
            let qname = p.name;
            if (!qname) {
              const qm = url.match(/[?&]query=([^&]+)/);
              if (qm) qname = decodeURIComponent(qm[1]).replace(/\+/g, ' ');
            }
            if (qname) {
              pid = await findPlaceId(qname, p.lat, p.lng);
              method = pid ? 'find_place_api' : '';
            }
          }
        }
        // 3) フォールバック: URL ですらない (ページタイトル等) → タブ自身の店名+座標で Text Search
        if (!pid) {
          const ts = tabShopByRow[masterRow];
          if (ts && ts.name && isFinite(ts.lat) && isFinite(ts.lng)) {
            pid = await findPlaceId(ts.name, ts.lat, ts.lng);
            method = pid ? 'fallback_master' : '';
          }
        }
        if (!pid) {
          results.push({ row: masterRow, pasted, error: 'Place ID 抽出失敗' });
          continue;
        }
        updates.push({
          range: `'${SHEET_NAME}'!AK${masterRow}:AK${masterRow}`,
          values: [[pid]],
        });
        results.push({ row: masterRow, pid, method });
      }
      if (updates.length > 0) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
        });
      }
      // K列 (反映状態) も更新
      const stateUpdates: any[] = [];
      let i = 0;
      for (const row of rows) {
        i++;
        const masterRow = parseInt(String(row[0] || '').trim(), 10);
        if (!masterRow) continue;
        const r = results.find(r => r.row === masterRow);
        let state = '(未入力)';
        if (r) {
          if (r.pid) state = `✓ ${r.method||''} ${r.pid}`;
          else state = '✗ ' + (r.error || '');
        }
        stateUpdates.push({
          range: `'${TAB_NAME}'!K${i + 1}:K${i + 1}`,
          values: [[state]],
        });
      }
      if (stateUpdates.length > 0) {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: stateUpdates }),
        });
      }
      return new Response(JSON.stringify({ success: true, updated: updates.length, total: results.length, results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
