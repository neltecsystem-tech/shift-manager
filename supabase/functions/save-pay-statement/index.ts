import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface StatementRow {
  d: string;
  ymd: string;
  dow: string;
  am_course: string;
  am: number;
  am_detail: string;
  pm_course: string;
  pm: number;
  pm_detail: string;
  total: number;
}

interface StatementPayload {
  staff_name: string;
  phone: string;
  year: number;
  month: number;
  am_sum: number;
  pm_sum: number;
  grand_total: number;
  rows: StatementRow[];
  calc_type?: string | null;
  calc_type_pm?: string | null;
  biz_type?: string | null;
  company_name?: string | null;
  primary_area?: string | null;
}

interface Payload {
  admin_password?: string;
  auth_token?: string;
  finalized_by?: string;
  statement?: StatementPayload;
  statements?: StatementPayload[];
}

// invoice-sheet と共有の HMAC token 検証 (SHIFT_SESSION_SECRET)
const SESSION_SECRET = Deno.env.get('SHIFT_SESSION_SECRET') || '';
function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function hmacSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function verifyShiftToken(token: string | undefined | null): Promise<any | null> {
  if (!token || !SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const expected = await hmacSign(parts[0]);
    if (expected.length !== parts[1].length) return null;
    let diff = 0; for (let i = 0; i < parts[1].length; i++) diff |= expected.charCodeAt(i) ^ parts[1].charCodeAt(i);
    if (diff !== 0) return null;
    const claims = JSON.parse(b64urlDecode(parts[0]));
    if (claims.exp && claims.exp < Date.now()) return null;
    return claims;
  } catch { return null; }
}

function normalizePhone(s: string): string {
  if (!s) return '';
  return s
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/[^\d]/g, '');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function validateStatement(s: StatementPayload): string | null {
  if (!s.staff_name) return 'staff_name required';
  // 電話番号は任意(未登録でも確定可能)。無い人は明細ビューアで氏名照合になる。キーは staff_name。
  if (!Number.isInteger(s.year) || s.year < 2020 || s.year > 2100) return 'year invalid';
  if (!Number.isInteger(s.month) || s.month < 1 || s.month > 12) return 'month invalid';
  if (!Array.isArray(s.rows)) return 'rows must be array';
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as Payload;
    // 認証: HMAC token (shift admin_login で発行) のみ。 admin_password は廃止
    const claims = await verifyShiftToken(body.auth_token);
    if (claims?.role !== 'admin') return json({ error: 'unauthorized', code: 'AUTH_REQUIRED' }, 401);

    const all: StatementPayload[] = body.statement
      ? [body.statement]
      : Array.isArray(body.statements)
        ? body.statements
        : [];
    if (all.length === 0) return json({ error: 'statement or statements required' }, 400);

    for (const s of all) {
      const err = validateStatement(s);
      if (err) return json({ error: `validation failed: ${err} (staff_name=${s.staff_name})` }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const finalizedBy = body.finalized_by ?? 'admin';
    const now = new Date().toISOString();

    const upserted: { staff_name: string; year: number; month: number; modified: boolean }[] = [];
    for (const s of all) {
      const phone = normalizePhone(s.phone);
      const { data: existing } = await admin
        .from('closed_pay_statements')
        .select('id')
        .eq('staff_name', s.staff_name)
        .eq('year', s.year)
        .eq('month', s.month)
        .maybeSingle();

      const record = {
        staff_name: s.staff_name,
        phone,
        year: s.year,
        month: s.month,
        am_sum: Math.round(s.am_sum || 0),
        pm_sum: Math.round(s.pm_sum || 0),
        grand_total: Math.round(s.grand_total || 0),
        rows: s.rows,
        calc_type: s.calc_type ?? null,
        calc_type_pm: s.calc_type_pm ?? null,
        biz_type: s.biz_type ?? null,
        company_name: s.company_name ?? null,
        primary_area: s.primary_area ?? null,
      };

      if (existing) {
        const { error } = await admin
          .from('closed_pay_statements')
          .update({
            ...record,
            modified_at: now,
            modified_by: finalizedBy,
          })
          .eq('id', existing.id);
        if (error) return json({ error: `update failed: ${error.message}` }, 500);
        upserted.push({ staff_name: s.staff_name, year: s.year, month: s.month, modified: true });
      } else {
        const { error } = await admin
          .from('closed_pay_statements')
          .insert({
            ...record,
            finalized_at: now,
            finalized_by: finalizedBy,
          });
        if (error) return json({ error: `insert failed: ${error.message}` }, 500);
        upserted.push({ staff_name: s.staff_name, year: s.year, month: s.month, modified: false });
      }
    }

    return json({ ok: true, saved: upserted.length, details: upserted });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});