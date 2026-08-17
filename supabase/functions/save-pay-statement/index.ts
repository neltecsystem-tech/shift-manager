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
  planner_allowance?: number | null;
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
  action?: string;
  year?: number;
  month?: number;
}

// コース名から営業所 (index.html の areaOfCourse と同じ規則)
function areaOfCourse(c: string): string {
  const s = String(c || '');
  if (s.startsWith('城北')) return '城北';
  if (s.startsWith('川越')) return '川越';
  if (s.startsWith('立川')) return '立川';
  if (s.startsWith('川崎')) return '川崎高津';
  return '';
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

    // ── 確定済み支払いの営業所別サマリー ──
    // 収支管理はこれまで毎回シフト+単価マスタから外注費を計算し直しており、
    // Sheets の読取上限(429)に当たると金額が黙って小さく出ていた。
    // 支払いは「確定・公開」で closed_pay_statements に保存済みなので、
    // 確定済みの月はその数字をそのまま使う。日別の行にコース名が入っているので
    // 営業所別も出せる。集計はここ(サーバ)で完結させ、明細は返さない。
    if (body.action === 'summary') {
      const year = Number(body.year), month = Number(body.month);
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return json({ error: 'year/month required' }, 400);
      }
      const admin0 = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const { data, error } = await admin0
        .from('closed_pay_statements')
        .select('staff_name, grand_total, planner_allowance, primary_area, rows, finalized_at')
        .eq('year', year).eq('month', month);
      if (error) return json({ error: error.message }, 500);
      const list = data ?? [];
      const byArea: Record<string, number> = {};
      let total = 0, attributed = 0, lastAt = '';
      for (const s of list) {
        total += Number(s.grand_total) || 0;
        if (s.finalized_at && String(s.finalized_at) > lastAt) lastAt = String(s.finalized_at);
        const perArea: Record<string, number> = {};
        let mine = 0;
        for (const r of (Array.isArray(s.rows) ? s.rows : []) as StatementRow[]) {
          const a1 = areaOfCourse(r?.am_course ?? ''); const v1 = Number(r?.am) || 0;
          if (a1 && v1) { perArea[a1] = (perArea[a1] ?? 0) + v1; mine += v1; }
          const a2 = areaOfCourse(r?.pm_course ?? ''); const v2 = Number(r?.pm) || 0;
          if (a2 && v2) { perArea[a2] = (perArea[a2] ?? 0) + v2; mine += v2; }
        }
        // コースの付かない支払い(プランナー手当・特別日当・営業所を判定できないコース)は
        // その人が実際に稼働した営業所の金額比で按分する。稼働営業所が取れない人は
        // primary_area へ、それも無ければ未配分として残す。
        const leftover = Math.round((Number(s.grand_total) || 0) - mine);
        const areas = Object.keys(perArea);
        if (leftover > 0 && areas.length) {
          let dealt = 0;
          areas.forEach((a, i) => {
            const v = i === areas.length - 1 ? leftover - dealt : Math.round(leftover * (perArea[a] / mine));
            dealt += v; perArea[a] += v;
          });
        } else if (leftover > 0 && s.primary_area) {
          perArea[String(s.primary_area)] = (perArea[String(s.primary_area)] ?? 0) + leftover;
        }
        for (const [a, v] of Object.entries(perArea)) { byArea[a] = (byArea[a] ?? 0) + v; attributed += v; }
      }
      // 人別の合計も返す (収支のスタッフ別表示用)。明細行は返さない。
      const byStaff = list
        .map((s) => ({ staff: String(s.staff_name || ''), amount: Number(s.grand_total) || 0 }))
        .filter((x) => x.staff && x.amount)
        .sort((a, b) => b.amount - a.amount);
      return json({
        year, month, staff_count: list.length, finalized: list.length > 0,
        total, by_area: byArea, by_staff: byStaff, unassigned: Math.max(0, total - attributed),
        last_finalized_at: lastAt || null,
      });
    }

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
        planner_allowance: Math.round(Number(s.planner_allowance) || 0),
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