// fetch-shift — シフト表(Googleスプレッドシート)の読み書きEF
//
// 🚨 このファイルは「本番にデプロイ済みのバンドル(version 56)から復元」したもの。
//    元のソースはどのリポジトリにも残っていなかった。復元経路の都合で
//    型注釈は落ちている(実行コードは本番と同一)。以後はこのファイルを正とする。
//
// 認証: 本EFは verify_jwt=false の公開EF。読み取り(list_sheets/fetch_sheet/
//       fetch_cached_shifts)は素通し、書き込み系は shop-master と同じ
//       HMAC セッショントークン(SHIFT_SESSION_SECRET)を必須にしている。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const SHIFT_SPREADSHEET = '1yVKQLSmdc9RZ2U5m4CIPqAl4JqP9siiSeSRP0z3SEEM';
const SA = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY'));
function b64url(d) {
  return btoa(d).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getToken(scope = 'https://www.googleapis.com/auth/spreadsheets.readonly') {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT'
  }));
  const p = b64url(JSON.stringify({
    iss: SA.client_email,
    scope,
    aud: SA.token_uri,
    iat: now,
    exp: now + 3600
  }));
  const pk = SA.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\n/g, '');
  const der = Uint8Array.from(atob(pk), (c)=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch(SA.token_uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${h}.${p}.${s}`
  });
  return (await r.json()).access_token;
}
function colToA1(col) {
  let s = '';
  let n = col;
  while(n >= 0){
    s = String.fromCharCode(65 + n % 26) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}
// ---- 呼び出し元認証 (shop-master / invoice-sheet と同じ HMAC セッショントークン) ----
// 本EFは verify_jwt=false の公開EF。読み取りは素通しのままで良いが、書き込み系は
// 無認証の第三者がシフト表・人員名簿・単価マスタを書き換え/行削除できてしまうため塞ぐ。
const SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';
const FS_ADMIN_PASSWORD = Deno.env.get('SHIFT_ADMIN_PASSWORD') || '';
// 段階導入: 既定は監査モード(警告ログのみで実行は通す)。呼び出し漏れが無いことを
// ログで確認してから FETCH_SHIFT_ENFORCE=1 を設定して遮断に切り替える。
const ENFORCE = Deno.env.get('FETCH_SHIFT_ENFORCE') === '1';
function b64urlDecodeUtf8(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++)bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function hmacSign(payload) {
  if (!SESSION_SECRET) throw new Error('SHIFT_SESSION_SECRET not set');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  try {
    const expected = await hmacSign(payload);
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for(let i = 0; i < sig.length; i++)diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;
    const claims = JSON.parse(b64urlDecodeUtf8(payload));
    if (claims.exp && claims.exp < Date.now()) return null;
    return claims;
  } catch  {
    return null;
  }
}
// シート(シフト表・人員名簿・単価マスタ等)を書き換えるアクション。ログイン必須。
// 読み取り(list_sheets / fetch_sheet / fetch_cached_shifts)は従来どおり素通し。
const WRITE_ACTIONS = new Set([
  'update_cells',
  'update_range',
  'create_sheet',
  'format_cells',
  'append_row',
  'delete_rows',
  'insert_row_at',
  'move_rows'
]);
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const body = await req.json().catch(()=>({}));
    if (WRITE_ACTIONS.has(body.action)) {
      const adminPwOk = !!FS_ADMIN_PASSWORD && body.admin_password === FS_ADMIN_PASSWORD;
      const claims = adminPwOk ? {
        role: 'admin'
      } : await verifyToken(body.auth_token);
      if (!claims) {
        // 監査ログ: 遮断前に「トークン無しで来ている呼び出し」を洗い出すための記録
        console.warn(`[fetch-shift][AUTH_AUDIT] action=${body.action} sheet=${body.sheet_name || ''} origin=${req.headers.get('origin') || '-'} enforce=${ENFORCE}`);
        if (ENFORCE) {
          return new Response(JSON.stringify({
            error: 'ログインが必要です（再ログインしてください）',
            code: 'AUTH_REQUIRED'
          }), {
            status: 401,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
      }
    }
    if (body.action === 'fetch_cached_shifts') {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const supabase = createClient(supabaseUrl, serviceKey);
      const { data, error } = await supabase.from('shift_sheet_cache').select('sheet_name, rows, updated_at, status').order('sheet_name');
      if (error) {
        return new Response(JSON.stringify({
          error: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        sheets: data || []
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'list_sheets') {
      const token = await getToken();
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const mj = await meta.json();
      const sheets = (mj.sheets || []).map((s)=>s.properties.title);
      const shiftSheets = sheets.filter((t)=>/シフト|月.*\d{4}|\d{4}.*月/.test(t));
      const otherSheets = sheets.filter((t)=>/人員名簿|曜日別|シート26|最新/.test(t));
      return new Response(JSON.stringify({
        shift_sheets: shiftSheets,
        other_sheets: otherSheets,
        all_sheets: sheets
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'fetch_sheet') {
      const token = await getToken();
      const name = body.sheet_name;
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      if (!name) {
        return new Response(JSON.stringify({
          error: 'sheet_name required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(name)}!A1:ZZ500`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Sheet fetch failed: ' + err.slice(0, 200)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const data = await resp.json();
      return new Response(JSON.stringify({
        sheet_name: name,
        rows: data.values || []
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'update_cells') {
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      const updates = body.updates || [];
      if (!name || !Array.isArray(updates) || !updates.length) {
        return new Response(JSON.stringify({
          error: 'sheet_name and updates required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const data = updates.map((u)=>{
        const a1 = `${colToA1(u.col)}${u.row + 1}`;
        return {
          range: `${name}!${a1}`,
          values: [
            [
              u.value == null ? '' : String(u.value)
            ]
          ]
        };
      });
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data
        })
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Update failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const j = await resp.json();
      return new Response(JSON.stringify({
        success: true,
        updated: j.totalUpdatedCells || 0
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'update_range') {
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const range = body.range;
      const values = body.values;
      if (!name || !range || !Array.isArray(values)) {
        return new Response(JSON.stringify({
          error: 'sheet_name, range, values required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const a1 = `${name}!${range}`;
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          values
        })
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Update failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const j = await resp.json();
      return new Response(JSON.stringify({
        success: true,
        updated: j.updatedCells || 0
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'create_sheet') {
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const templateName = body.template_sheet_name;
      if (!name) {
        return new Response(JSON.stringify({
          error: 'sheet_name required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}?fields=sheets.properties`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const mj = await meta.json();
      const existing = (mj.sheets || []).find((s)=>s.properties.title === name);
      if (existing) {
        return new Response(JSON.stringify({
          error: 'Sheet already exists',
          sheet_id: existing.properties.sheetId
        }), {
          status: 409,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (templateName) {
        const tpl = (mj.sheets || []).find((s)=>s.properties.title === templateName);
        if (!tpl) {
          return new Response(JSON.stringify({
            error: 'template not found: ' + templateName
          }), {
            status: 404,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        const dup = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            requests: [
              {
                duplicateSheet: {
                  sourceSheetId: tpl.properties.sheetId,
                  newSheetName: name
                }
              }
            ]
          })
        });
        if (!dup.ok) {
          const err = await dup.text();
          return new Response(JSON.stringify({
            error: 'Duplicate failed: ' + err.slice(0, 300)
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        const dj = await dup.json();
        return new Response(JSON.stringify({
          success: true,
          sheet_id: dj.replies?.[0]?.duplicateSheet?.properties?.sheetId,
          copied_from: templateName
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      } else {
        const add = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            requests: [
              {
                addSheet: {
                  properties: {
                    title: name
                  }
                }
              }
            ]
          })
        });
        if (!add.ok) {
          const err = await add.text();
          return new Response(JSON.stringify({
            error: 'Add failed: ' + err.slice(0, 300)
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        const aj = await add.json();
        return new Response(JSON.stringify({
          success: true,
          sheet_id: aj.replies?.[0]?.addSheet?.properties?.sheetId
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    if (body.action === 'format_cells') {
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const cells = body.cells || [];
      const bg = body.bg || {
        red: 0,
        green: 0,
        blue: 0
      };
      if (!name || !Array.isArray(cells) || !cells.length) {
        return new Response(JSON.stringify({
          error: 'sheet_name and cells required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}?fields=sheets.properties`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const mj = await meta.json();
      const sh = (mj.sheets || []).find((s)=>s.properties.title === name);
      if (!sh) {
        return new Response(JSON.stringify({
          error: 'sheet not found: ' + name
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const sheetId = sh.properties.sheetId;
      const requests = cells.map((c)=>({
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: c.row,
              endRowIndex: c.row + 1,
              startColumnIndex: c.col,
              endColumnIndex: c.col + 1
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: bg
              }
            },
            fields: 'userEnteredFormat.backgroundColor'
          }
        }));
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHIFT_SPREADSHEET}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests
        })
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Format failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        success: true,
        formatted: cells.length
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'append_row') {
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const values = body.values;
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      if (!name || !Array.isArray(values)) {
        return new Response(JSON.stringify({
          error: 'sheet_name and values (array) required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // A1基準の :append は Google のテーブル検出に依存し、シート上部に別の塊があると
      // そこへ誤爆する。実データの最終行を自前で検出し、その直下へ確定的に PUT する。
      const readResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(name)}!A1:ZZ2000`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!readResp.ok) {
        const err = await readResp.text();
        return new Response(JSON.stringify({
          error: 'Append(read) failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const existing = (await readResp.json()).values || [];
      let lastRow = 0; // 1-based。0=空シート
      for(let i = 0; i < existing.length; i++){
        if ((existing[i] || []).some((c)=>String(c == null ? '' : c).trim() !== '')) lastRow = i + 1;
      }
      const targetRow = lastRow + 1;
      const endCol = colToA1(Math.max(0, values.length - 1));
      const putRange = `${name}!A${targetRow}:${endCol}${targetRow}`;
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(putRange)}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          values: [
            values
          ]
        })
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Append failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const j = await resp.json();
      return new Response(JSON.stringify({
        success: true,
        updated_range: j.updatedRange || putRange,
        appended_row: targetRow
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'delete_rows') {
      // 指定した0始まり行インデックスを行ごと削除 (deleteDimension=書式ごと詰まる)。
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      const rowIndices = Array.isArray(body.row_indices) ? body.row_indices : [];
      if (!name || !rowIndices.length) {
        return new Response(JSON.stringify({
          error: 'sheet_name and row_indices (array of 0-based indices) required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const mj = await meta.json();
      const sh = (mj.sheets || []).find((s)=>s.properties.title === name);
      if (!sh) {
        return new Response(JSON.stringify({
          error: 'sheet not found: ' + name
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const sheetId = sh.properties.sheetId;
      // 降順で1行ずつ削除 → 削除による行シフトが未処理インデックスに影響しない
      const sorted = [
        ...new Set(rowIndices.map((n)=>Number(n)))
      ].filter((n)=>Number.isInteger(n) && n >= 0).sort((a, b)=>b - a);
      const requests = sorted.map((idx)=>({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: idx,
              endIndex: idx + 1
            }
          }
        }));
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests
        })
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Delete failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        success: true,
        deleted: sorted.length,
        indices: sorted
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'insert_row_at') {
      // row_index(0始まり)の位置へ空行を1行挿入し(書式は上行を継承)、values があれば書き込む。
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      const rowIndex = Number(body.row_index);
      const values = Array.isArray(body.values) ? body.values : null;
      if (!name || !Number.isInteger(rowIndex) || rowIndex < 0) {
        return new Response(JSON.stringify({
          error: 'sheet_name and row_index (0-based int) required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const mj = await meta.json();
      const sh = (mj.sheets || []).find((s)=>s.properties.title === name);
      if (!sh) {
        return new Response(JSON.stringify({
          error: 'sheet not found: ' + name
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const sheetId = sh.properties.sheetId;
      const insResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: rowIndex,
                  endIndex: rowIndex + 1
                },
                inheritFromBefore: rowIndex > 0
              }
            }
          ]
        })
      });
      if (!insResp.ok) {
        const err = await insResp.text();
        return new Response(JSON.stringify({
          error: 'Insert failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (values && values.length) {
        const endCol = colToA1(Math.max(0, values.length - 1));
        const putRange = `${name}!A${rowIndex + 1}:${endCol}${rowIndex + 1}`;
        const putResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(putRange)}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            values: [
              values
            ]
          })
        });
        if (!putResp.ok) {
          const err = await putResp.text();
          return new Response(JSON.stringify({
            error: 'Insert(write) failed: ' + err.slice(0, 300)
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
      }
      return new Response(JSON.stringify({
        success: true,
        inserted_row: rowIndex + 1
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (body.action === 'move_rows') {
      // from_index(0始まり)の行を to_index(0始まり・移動前座標系での着地位置)へ移動。
      // moveDimension は値も書式(黒塗り等)も丸ごと保持して物理移動する。
      const token = await getToken('https://www.googleapis.com/auth/spreadsheets');
      const name = body.sheet_name;
      const spreadsheetId = body.spreadsheet_id || SHIFT_SPREADSHEET;
      const fromIndex = Number(body.from_index);
      const toIndex = Number(body.to_index);
      if (!name || !Number.isInteger(fromIndex) || fromIndex < 0 || !Number.isInteger(toIndex) || toIndex < 0) {
        return new Response(JSON.stringify({
          error: 'sheet_name, from_index, to_index (0-based ints) required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (fromIndex === toIndex) {
        return new Response(JSON.stringify({
          success: true,
          moved: false,
          note: 'from == to'
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const mj = await meta.json();
      const sh = (mj.sheets || []).find((s)=>s.properties.title === name);
      if (!sh) {
        return new Response(JSON.stringify({
          error: 'sheet not found: ' + name
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const sheetId = sh.properties.sheetId;
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              moveDimension: {
                source: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: fromIndex,
                  endIndex: fromIndex + 1
                },
                destinationIndex: toIndex
              }
            }
          ]
        })
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({
          error: 'Move failed: ' + err.slice(0, 300)
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        success: true,
        moved: true,
        from: fromIndex,
        to: toIndex
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: 'Unknown action. Use list_sheets, fetch_sheet, fetch_cached_shifts, update_cells, update_range, create_sheet, format_cells, append_row, delete_rows, insert_row_at, move_rows'
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: e.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
