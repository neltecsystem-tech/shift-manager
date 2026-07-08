import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 自己修復③: sm_error_logs を Claude が原因推定＋修正案にまとめる「診断ブレイン」。
// action:
//  - 'summary' (既定/読み取り): 直近エラー(集約)＋最新診断を返す。監視画面が表示に使う。
//  - 'run': Claudeで診断を実行し sm_error_diagnoses に保存。過度な実行はスロットル。
//    cron からは {action:'run', secret:<SM_DIAG_SECRET>} で throttle を無視して強制実行。
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const DIAG_SECRET = Deno.env.get('SM_DIAG_SECRET') || '';
const MODEL = 'claude-sonnet-4-6';

interface Grp { message: string; count: number; kinds: string[]; views: string[]; builds: string[]; healed: number; sample_stack: string | null; last: string; }

function groupErrors(rows: any[]): Grp[] {
  const map = new Map<string, Grp>();
  for (const r of rows) {
    const key = (r.message || '(no message)').slice(0, 200);
    let g = map.get(key);
    if (!g) { g = { message: key, count: 0, kinds: [], views: [], builds: [], healed: 0, sample_stack: null, last: r.created_at }; map.set(key, g); }
    g.count++;
    if (r.kind && !g.kinds.includes(r.kind)) g.kinds.push(r.kind);
    if (r.view && !g.views.includes(r.view)) g.views.push(r.view);
    if (r.build && !g.builds.includes(r.build)) g.builds.push(r.build);
    if (r.healed) g.healed++;
    if (!g.sample_stack && r.stack) g.sample_stack = String(r.stack).slice(0, 1200);
    if (r.created_at > g.last) g.last = r.created_at;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

async function runClaude(groups: Grp[]): Promise<{ summary: string; items: any[] }> {
  const compact = groups.slice(0, 20).map((g) => ({
    エラー: g.message, 件数: g.count, 種類: g.kinds, 画面: g.views, build: g.builds, 自己修復済: g.healed, stack抜粋: g.sample_stack,
  }));
  const prompt = `あなたは社内Webツール「新聞シフト管理(shift-manager)」の運用担当エンジニアです。これは Vanilla JS の単一HTML(index.html)で、Supabase Edge Functions と Google Sheets を fetch で叩く静的アプリです。
以下は直近に自動収集したフロントエンドの未捕捉エラー集計(JSON)です。運用者が読んで対処判断できるよう診断してください。

${JSON.stringify(compact, null, 1)}

次の JSON のみを返してください(前置き不要):
{"summary":"全体の状況を1〜2文の日本語で","items":[{"title":"短い見出し","severity":"low|medium|high","likely_cause":"推定原因(日本語・具体的に)","suggested_fix":"推奨対処(日本語。コード箇所やキャッシュ/EF/Sheets等の切り分けを具体的に)","self_healed":true/false}]}
注意: 件数が多い/画面が主要機能/自己修復で解消していないものを high に。ユーザー端末のネット瞬断や拡張機能由来の可能性があるものは low とし、その旨を書く。推測は推測と明記し、断定しない。`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error('Claude API ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  const jr = await resp.json();
  const text = (jr.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('診断JSON抽出失敗');
  const parsed = JSON.parse(m[0]);
  return { summary: String(parsed.summary || ''), items: Array.isArray(parsed.items) ? parsed.items : [] };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body.action || 'summary');
    const app = String(body.app || 'shift-manager');
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 直近7日のエラー集約 + 最新診断
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: logs } = await sb.from('sm_error_logs').select('created_at, kind, view, build, message, stack, healed').eq('app', app).gte('created_at', since).order('created_at', { ascending: false }).limit(500);
    const rows = logs ?? [];
    const groups = groupErrors(rows);
    const { data: lastDiag } = await sb.from('sm_error_diagnoses').select('*').eq('app', app).order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (action === 'summary') {
      return json({ ok: true, error_count: rows.length, groups: groups.slice(0, 30), latest: lastDiag ?? null });
    }

    if (action === 'run') {
      // スロットル: 最新診断が2分以内なら再実行しない(cronはsecretで強制)
      const forced = DIAG_SECRET && body.secret === DIAG_SECRET;
      if (!forced && lastDiag && (Date.now() - new Date(lastDiag.created_at).getTime() < 120000)) {
        return json({ ok: true, throttled: true, latest: lastDiag });
      }
      if (!groups.length) return json({ ok: true, empty: true, latest: lastDiag ?? null });
      const result = await runClaude(groups);
      const { data: saved } = await sb.from('sm_error_diagnoses').insert({
        app, window_from: since, error_count: rows.length, summary: result.summary, items: result.items, model: MODEL,
      }).select('*').single();
      return json({ ok: true, latest: saved, error_count: rows.length, groups: groups.slice(0, 30) });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
