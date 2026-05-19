import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SPREADSHEET_ID = '1Owv83TGxSl15pqO0MaaF4AaLeslye0frfKAuo62TlGY';
const SHEET_NAME = '店舗マスタ';
const MASTER2_SHEET = 'マスタ2';
const COL_END = 'AI';
const N_COLS = 35;

const SERVICE_ACCOUNT = {
  client_email: 'workchat@my-project-78970-492704.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCbftKwy+UTdvNJ\nPUTNkw4hVNMam55Kz/FBPUGlda4aGY1JLafRI4zYKvRDJO4aK3pTewf+hUJlghfL\nmxh52RufPfubbMobOT9K2RylwGh07fA8mZxtGI/adUScXStcpWik7S450XeK+2f9\nrFxanDPTTRe6hducqgm3Dzrv039e1YnInN7gS8+EvHvNvbAbfaPo6z4WQmiCtA9q\nMcRndTENcCjfaiaE3hCAT+BWIfRRYy7tC10vzMrP+3mSkXgL8utVLwqceMepOg9F\nHNlkj/6TEtgeFrKP4FtDUfSBGVGKcmp2Kq3LLZC04mt2xKMCflKkaV8IZQCTtujR\n31ULuc8jAgMBAAECggEAS5wmICDtMYNQNodL2viMUOnZwuDz3iXyBoqeTrID6B4P\npQtFxHzYYk60uqeM/f2xPEGheAJdcFWLc45lnu5Sr6Koo4GJXyZ9n8wl0XVXdbAz\ndowtU6EzZgNKywvE54Zo9XV9WlEAI30vKlszBz5YNwGQLbskODA4jCKkQnThxP8n\nsCDYL4frjwDL2ivt2PWnHRlQtJsK4cBiP53nuMSNII+WwNlPEaJxJIpunxTv1inY\nye8Y0hlLioVzXG8OmBzr9/FrvFCSk9vyvOG578E4HbrcJDLRH0JY9Dzv2X7ZCqaC\ndM+mYapVjRMFiHAxA+5W58K1l0eEjD4J0r5kY4OunQKBgQDLaJtA+7BbUPRAc68V\nhjINkrlthmw0+uBFvCgR8CChGJ90gGAxY+LuaOU+uXekXU034ak15RbjdpKYY5Gr\nGHlsNZ57ABqJTRqT0UpMgTlGrBKGsApdh8rWFHJaiaCTZoLr0+HuBQz36cGj61L8\nepEBZY2qCyi66YrPev3mmlMUHwKBgQDDsuSspq6WozFP5aks+3VRyGdwNBlQtorn\n8fU3tmSsg38OVQ2UyU9U4sxNa1QaoLsvffBLxwAR1rJPANQlyiCUaqLsb/Ib1FUf\nojPqOgdIURSmvBBEEJFDTj6EiuJrhbU8kNfWBw3wF3exynuxRTxtHbtuN1v2+QrJ\n3THsdBeEfQKBgDNDoOVGyZKqG3Tm8vhkwtai5PLSjxDnLYDFw/+JWl/fech91kB8\nYSQe8a/WRG37ScvMpr27iAI5zwZzCbJqT6fS96ceRpHWCd25QJV5d/r0wRKK6YHb\nCGbd7lgdGYgsrNBMrUM0qKkOk8wBMgAJz+PfOU3i1BgPZfmWkMj+mfOXAoGASneG\nQJRklvmeSBLSH0XITMh/Y9jPUUFE9iHB9+M1x9d5v5BpzJYV0+1BZKxUopVK5TV8\n/LjKs/8IdruP/pk9cHxrZqDqdeCES7dDHfvazY/c1d12KxBK1lutum3G3rdQUa2k\nE9M3YIbtiv/LtZbs+XB44+W43u/BRTMgTiOW11kCgYAJ8lPHU1LaWBx4NljrpRKM\nEXaMt7lU78XXHnoR7wl21q8AWWVpJGphFXQvIGLcEJGAFksNrrkoUGXIiUHoiCsc\n9btykTJn1/GM8DkXF/TyIdgaL0UqDjU4tOwkayuI/D0nsgl2oQIP/ljU2HSiJIIY\nydAjQkwA4v75yjsVXjt8Kw==\n-----END PRIVATE KEY-----\n`,
  token_uri: 'https://oauth2.googleapis.com/token',
};

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
  // AF=住所, AG=住所精度, AH=ナビ判定, AI=正式店舗名
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AI2`, { headers: { 'Authorization': `Bearer ${token}` } });
  const j = await r.json();
  const cur = (j.values?.[0] ?? []) as string[];
  const next = [
    (cur[0] || '').trim() || '住所',
    (cur[1] || '').trim() || '住所精度',
    (cur[2] || '').trim() || 'ナビ判定',
    (cur[3] || '').trim() || '正式店舗名',
  ];
  const changed = next.some((v, i) => v !== (cur[i] || '').trim());
  if (changed) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!AF2:AI2?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [next] }),
    });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { action, record, row_number, updates } = await req.json();
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
      Object.entries(record).forEach(([key, val]) => {
        const m = key.match(/^col_(\d+)$/);
        if (m) currentRow[parseInt(m[1])] = val as string;
      });
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A${row_number}:${COL_END}${row_number}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [currentRow] }),
      });
      return new Response(JSON.stringify({ success: true }), {
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
      return new Response(JSON.stringify({ success: true, updates: appendResult.updates ?? null }), {
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
