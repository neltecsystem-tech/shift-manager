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
  year_month?: string;
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as Payload;
    const phoneInput = normalizePhone(body.phone ?? '');
    const ym = (body.year_month ?? '').trim();
    if (!phoneInput) return json({ error: 'phone required' }, 400);
    if (!/^\d{4}-\d{2}$/.test(ym))
      return json({ error: 'year_month required (YYYY-MM)' }, 400);
    const [yStr, mStr] = ym.split('-');
    const year = Number(yStr);
    const month = Number(mStr);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await admin
      .from('closed_pay_statements')
      .select('*')
      .eq('phone', phoneInput)
      .eq('year', year)
      .eq('month', month);

    if (error) return json({ error: 'fetch failed: ' + error.message }, 500);

    const rows = data ?? [];
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
