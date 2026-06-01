import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SPREADSHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const SHEET_NAME = '店舗マスタ';
const MASTER2_SHEET = 'マスタ2';
const COL_END = 'AK';
const N_COLS = 37;
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
  // AF=住所, AG=住所精度, AH=ナビ判定, AI=正式店舗名, AJ=新夕刊コース, AK=Place ID
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AK2`, { headers: { 'Authorization': `Bearer ${token}` } });
  const j = await r.json();
  const cur = (j.values?.[0] ?? []) as string[];
  const next = [
    (cur[0] || '').trim() || '住所',
    (cur[1] || '').trim() || '住所精度',
    (cur[2] || '').trim() || 'ナビ判定',
    (cur[3] || '').trim() || '正式店舗名',
    (cur[4] || '').trim() || '新夕刊コース',
    (cur[5] || '').trim() || 'Place ID',
  ];
  const changed = next.some((v, i) => v !== (cur[i] || '').trim());
  if (changed) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AK2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [next] }),
    });
  }
}

// 列インデックス → A1表記の列文字
function colLetter(idx: number): string {
  let n = idx, s = '';
  while (n >= 0) { s = String.fromCharCode((n % 26) + 65) + s; n = Math.floor(n / 26) - 1; }
  return s;
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
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!B3:B10`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(MASTER2_SHEET)}!A3:A150`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      const areaJson = await areaResp.json();
      const courseJson = await courseResp.json();
      const areas = (areaJson.values || []).map((r: string[]) => (r[0] || '').trim()).filter(Boolean);
      const courses = (courseJson.values || []).map((r: string[]) => (r[0] || '').trim()).filter(Boolean);
      return new Response(JSON.stringify({ areas, courses }), {
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
