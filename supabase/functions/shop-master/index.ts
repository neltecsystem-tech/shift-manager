import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SPREADSHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const SHEET_NAME = '店舗マスタ';
const MASTER2_SHEET = 'マスタ2';
const COL_END = 'AJ';
const N_COLS = 36;
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
  // AF=住所, AG=住所精度, AH=ナビ判定, AI=正式店舗名, AJ=新夕刊コース
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AJ2`, { headers: { 'Authorization': `Bearer ${token}` } });
  const j = await r.json();
  const cur = (j.values?.[0] ?? []) as string[];
  const next = [
    (cur[0] || '').trim() || '住所',
    (cur[1] || '').trim() || '住所精度',
    (cur[2] || '').trim() || 'ナビ判定',
    (cur[3] || '').trim() || '正式店舗名',
    (cur[4] || '').trim() || '新夕刊コース',
  ];
  const changed = next.some((v, i) => v !== (cur[i] || '').trim());
  if (changed) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AJ2?valueInputOption=USER_ENTERED`, {
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
