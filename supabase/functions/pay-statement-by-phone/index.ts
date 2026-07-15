// 統合明細ビューア用: 電話番号 + 年月 で確定済み支払明細を返す
// closed_pay_statements テーブルを SELECT するだけ。計算ロジックは shift-manager の admin 画面側にある。

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface Payload {
  phone?: string;
  name?: string;
  year_month?: string;
  auth_token?: string;
}

function normalizePhone(s: string): string {
  if (!s) return '';
  return s
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/[^\d]/g, '');
}

// 氏名キー: 前後・中間の空白(全半角)を除去して比較用に正規化
function nmKey(s: string): string {
  return String(s ?? '').replace(/[\s　]/g, '');
}

// 氏名照合(電話番号未登録者の明細取得)は管理者のみ許可。
// shift EF は NexPort と同一プロジェクト(workchat)上なので、admin クライアントで
// caller の JWT を検証し profiles.role を確認できる。
async function callerIsAdmin(admin: any, authToken: string | undefined): Promise<boolean> {
  if (!authToken) return false;
  try {
    const { data: { user } } = await admin.auth.getUser(authToken);
    if (!user) return false;
    const { data: prof } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    return !!prof && (prof.role === 'admin' || prof.role === 'super_admin');
  } catch (_) {
    return false;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as Payload;
    const phoneInput = normalizePhone(body.phone ?? '');
    const nameInput = (body.name ?? '').trim();
    const ym = (body.year_month ?? '').trim();
    if (!phoneInput && !nameInput) return json({ error: 'phone or name required' }, 400);
    if (!/^\d{4}-\d{2}$/.test(ym))
      return json({ error: 'year_month required (YYYY-MM)' }, 400);
    const [yStr, mStr] = ym.split('-');
    const year = Number(yStr);
    const month = Number(mStr);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 電話番号があれば従来どおり電話で照合。無ければ氏名照合(管理者限定)。
    const byName = !phoneInput && !!nameInput;
    let rows: any[];
    if (byName) {
      if (!(await callerIsAdmin(admin, body.auth_token)))
        return json({ error: 'forbidden (name lookup is admin only)', code: 'FORBIDDEN' }, 403);
      const { data, error } = await admin
        .from('closed_pay_statements')
        .select('*')
        .eq('year', year)
        .eq('month', month);
      if (error) return json({ error: 'fetch failed: ' + error.message }, 500);
      const key = nmKey(nameInput);
      rows = (data ?? []).filter((s) => nmKey(s.staff_name ?? '') === key);
    } else {
      const { data, error } = await admin
        .from('closed_pay_statements')
        .select('*')
        .eq('phone', phoneInput)
        .eq('year', year)
        .eq('month', month);
      if (error) return json({ error: 'fetch failed: ' + error.message }, 500);
      rows = data ?? [];
    }
    if (rows.length === 0) {
      return json({ source: 'shift', found: false, reason: 'no_finalized_statement' });
    }

    return json({
      source: 'shift',
      found: true,
      year,
      month,
      statements: rows.map((s) => ({
        staff_name: s.staff_name,
        biz_type: s.biz_type,
        company_name: s.company_name,
        primary_area: s.primary_area,
        am_sum: s.am_sum,
        pm_sum: s.pm_sum,
        grand_total: s.grand_total,
        rows: s.rows,
        finalized_at: s.finalized_at,
        modified_at: s.modified_at,
      })),
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
