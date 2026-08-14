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
  company?: string;
  year_month?: string;
  auth_token?: string;
  list_all?: boolean; // 管理者限定: 当月の全支払明細を返す(明細ビューアの取引先一覧用)
}

function normalizePhone(s: string): string {
  if (!s) return '';
  return s
    .replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/[^\d]/g, '');
}

// 氏名/会社名の異体字(旧字体・許容字体)と小書きカナを代表字へ畳み込む。
// 会計とツールで表記が違う同一人物を一致させる。例: 舘野=館野, 斎藤=斉藤, 日ケ久保=日ヶ久保。
const CHAR_FOLD: Record<string, string> = {
  '髙': '高', '﨑': '崎', '嵜': '崎', '斎': '斉', '齋': '斉', '齊': '斉',
  '邊': '辺', '邉': '辺', '澤': '沢', '濱': '浜', '濵': '浜', '廣': '広',
  '德': '徳', '惠': '恵', '槇': '槙', '冨': '富', '峯': '峰', '舘': '館',
  '曾': '曽', '桒': '桑', '渕': '淵', '淸': '清', '靑': '青', '眞': '真',
  '圓': '円', '假': '仮', '國': '国', '瀨': '瀬', '增': '増', '莊': '荘',
  '禮': '礼', 'ヶ': 'ケ', 'ヵ': 'カ',
};
// 氏名キー: NFKC正規化 + 空白除去(全半角) + 異体字/カナ畳み込み。
function nmKey(s: string): string {
  const t = String(s ?? '').normalize('NFKC').replace(/[\s　]/g, '');
  let out = '';
  for (const ch of t) out += CHAR_FOLD[ch] ?? ch;
  return out;
}

// 会社名キー: nmKey に加えて法人格(株式会社/㈱/(株)等)と記号(・/中点/ハイフン/括弧)を除去し、
// ツール間の会社名表記ゆれ(半角㈱ vs 全角株式会社 等)を吸収する。会社名照合はこれで統一。
function coKey(s: string): string {
  return nmKey(s)
    .replace(/株式会社|有限会社|合同会社|合資会社|\(株\)|\(有\)|\(合\)|㈱|㈲/g, '')
    .replace(/[\s　・,，.。\-—–ー'"`（）()]/g, '')
    .toLowerCase();
}

// 🔒 他人の明細(氏名照合・会社集計・取引先一覧・他人の電話)を引けるのは「NELTEC社員の管理者」のみ。
//    管理者権限を持つ委託ドライバー(個人事業主)からは引けないようにする(2026-08-07)。
//    社員判定 = 中央人材マスタ staff_master.category='社員' (profile_id または電話で照合)。
//    super_admin は保守用に常に許可。
async function callerIsAdmin(admin: any, authToken: string | undefined): Promise<boolean> {
  if (!authToken) return false;
  try {
    const { data: { user } } = await admin.auth.getUser(authToken);
    if (!user) return false;
    const { data: prof } = await admin
      .from('profiles')
      .select('role, phone')
      .eq('id', user.id)
      .maybeSingle();
    if (!prof) return false;
    if (prof.role === 'super_admin') return true;
    if (prof.role !== 'admin') return false;
    const ph = normalizePhone(String((prof as any).phone ?? ''));
    const or = [`profile_id.eq.${user.id}`, ph ? `phone.eq.${ph}` : ''].filter(Boolean).join(',');
    const { data: sm } = await admin.from('staff_master').select('category').or(or).limit(5);
    return (sm ?? []).some((r: any) => String(r.category ?? '') === '社員');
  } catch (_) {
    return false;
  }
}

// 🔒 公開タイミング = 支払通知メールの発行に合わせる(2026-08〜)。確定しただけの明細は本人にも見せない。
//   公開条件: ① 自分宛の支払通知が発行済み(pay_statement_acceptance.issued_at) または
//            ② 実績月の翌月11日 9:00 JST を過ぎた(=2回目の送信cron)。
//   ②は保険。支払0円・メール未登録・明細停止などで通知が出ない人が、いつまでも自分の明細を
//   見られなくなるのを防ぐ。管理者(admin/super_admin)は従来どおり常に閲覧できる。
const PUBLISH_MSG = 'この月の明細は、支払通知書の発行後に公開されます（毎月1日・11日の朝に発行）。もうしばらくお待ちください。';
function publishOpenAt(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return Date.UTC(y, m, 11, 0, 0, 0); // 翌月11日 00:00 UTC = 09:00 JST
}
async function noticePublished(nx: any, profileId: string, ym: string): Promise<boolean> {
  if (Date.now() >= publishOpenAt(ym)) return true;
  if (!profileId) return false;
  const { data } = await nx.from('pay_statement_acceptance').select('issued_at').eq('month', ym).eq('profile_id', profileId).maybeSingle();
  return !!(data as any)?.issued_at;
}

// 呼び出し元(本人)の role/phone/オーナー情報。電話番号での明細取得を「本人/管理者/自社オーナー」に限定するため。
async function getCaller(admin: any, authToken: string | undefined): Promise<{ role: string; phone: string; is_company_owner: boolean; company: string; uid: string } | null> {
  if (!authToken) return null;
  try {
    const { data: { user } } = await admin.auth.getUser(authToken);
    if (!user) return null;
    const { data: prof } = await admin.from('profiles').select('role, phone, is_company_owner, company').eq('id', user.id).maybeSingle();
    if (!prof) return null;
    return { role: prof.role, phone: normalizePhone(prof.phone || ''), is_company_owner: !!prof.is_company_owner, company: String(prof.company || ''), uid: user.id };
  } catch (_) { return null; }
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
    const companyInput = (body.company ?? '').trim();
    const ym = (body.year_month ?? '').trim();
    const listAll = body.list_all === true || (body.list_all as unknown) === 'true';
    if (!phoneInput && !nameInput && !companyInput && !listAll) return json({ error: 'phone, name or company required' }, 400);
    if (!/^\d{4}-\d{2}$/.test(ym))
      return json({ error: 'year_month required (YYYY-MM)' }, 400);
    const [yStr, mStr] = ym.split('-');
    const year = Number(yStr);
    const month = Number(mStr);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 🔒 明細ビューア: 中央 login_access(meisai) で判定(管理者/明示停止/法人配下)。会計マトリクスに一本化。
    {
      const { data: { user: cu } } = await admin.auth.getUser(body.auth_token || '').catch(() => ({ data: { user: null } } as any));
      if (cu) {
        const chk = await fetch('https://nccognptoprhwsbjnwcu.supabase.co/functions/v1/check-login-access', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system: 'meisai', profile_id: cu.id, source: 'viewer-shift' }),
        }).then((x) => x.json()).catch(() => null);
        if (chk && chk.allowed === false) {
          const corp = chk.reason === 'corp_sub_denied';
          return json({ error: corp ? '法人配下の方の明細は、法人のオーナー/担当者がご確認ください。' : 'この明細ビューアのご利用は停止されています。担当者にお問い合わせください。', code: corp ? 'CORP_SUB_DENIED' : 'VIEWER_DISABLED' }, 403);
        }
      }
    }

    // 表示対象月の制限: 統合ビューア/通知運用は2026年7月開始。それより前の月は非管理者に表示しない。
    const MIN_YM = '2026-07';
    if (ym < MIN_YM && !listAll) {
      if (!(await callerIsAdmin(admin, body.auth_token)))
        return json({ source: 'shift', found: false, reason: 'month_not_available', message: '2026年7月分より前は表示対象外です' });
    }

    // 🔒 公開タイミングを支払通知メールに合わせる。確定しただけの明細は本人にも出さない。
    if (!listAll && !(await callerIsAdmin(admin, body.auth_token))) {
      const { data: { user: cu } } = await admin.auth.getUser(body.auth_token || '').catch(() => ({ data: { user: null } } as any));
      if (!(await noticePublished(admin, cu?.id ?? '', ym)))
        return json({ source: 'shift', found: false, reason: 'not_published', message: PUBLISH_MSG });
    }

    // 法人=会社名(company_name)で照合 / 個人=氏名(staff_name) or 電話。氏名・会社名照合は管理者限定。
    const byCompany = !listAll && !phoneInput && !nameInput && !!companyInput;
    const byName = !listAll && !phoneInput && !!nameInput && !companyInput;
    let rows: any[];
    if (listAll) {
      // 取引先一覧: 当月の確定明細(closed_pay_statements)を管理者へ返す。
      // ※ reflected_at ゲートは撤廃(2026-07): 確定済みなら即ビューア表示(会計はシート取込が正=別管理)。
      //   会計側(pay-sheet-sync)の reflected_at ゲートは別途維持=二重計上防止。
      if (!(await callerIsAdmin(admin, body.auth_token)))
        return json({ error: 'forbidden (list_all is admin only)', code: 'FORBIDDEN' }, 403);
      const { data, error } = await admin
        .from('closed_pay_statements')
        .select('*')
        .eq('year', year)
        .eq('month', month);
      if (error) return json({ error: 'fetch failed: ' + error.message }, 500);
      rows = data ?? [];
    } else if (byCompany || byName) {
      const isAdminCaller = await callerIsAdmin(admin, body.auth_token);
      // 氏名照合=管理者のみ。会社集計=管理者 or 自社オーナー/担当者(自社=会社名一致のみ)。
      if (byName && !isAdminCaller)
        return json({ error: 'forbidden (name lookup is admin only)', code: 'FORBIDDEN' }, 403);
      if (byCompany && !isAdminCaller) {
        const caller = await getCaller(admin, body.auth_token);
        let isOwnerOrContact = !!caller?.is_company_owner;
        const companies: string[] = [];
        if (caller?.company) companies.push(caller.company);
        // staff_master を 電話 or profile_id で照合(電話未登録のオーナー/担当でもアカウントで自社特定)。
        const smOr = [caller?.phone ? `phone.eq.${caller.phone}` : '', caller?.uid ? `profile_id.eq.${caller.uid}` : ''].filter(Boolean).join(',');
        if (smOr) {
          const { data: sms } = await admin.from('staff_master').select('company_name, is_company_owner, is_company_contact').or(smOr);
          for (const sm of (sms ?? [])) { if ((sm as any).company_name) companies.push(String((sm as any).company_name)); if ((sm as any).is_company_owner || (sm as any).is_company_contact) isOwnerOrContact = true; }
        }
        const cKey = coKey(companyInput);
        const companyMatch = !!cKey && companies.some((c) => coKey(c) === cKey);
        if (!(isOwnerOrContact && companyMatch))
          return json({ error: 'forbidden (自社の会社集計のみ閲覧できます)', code: 'FORBIDDEN' }, 403);
      }
      const { data, error } = await admin
        .from('closed_pay_statements')
        .select('*')
        .eq('year', year)
        .eq('month', month);
      if (error) return json({ error: 'fetch failed: ' + error.message }, 500);
      if (byCompany) {
        const ckey = coKey(companyInput);
        rows = (data ?? []).filter((s) => ckey && coKey(s.company_name ?? '').includes(ckey));
      } else {
        const key = nmKey(nameInput);
        rows = (data ?? []).filter((s) => nmKey(s.staff_name ?? '') === key);
      }
    } else {
      // 🔒 電話番号での本人明細取得: 本人 or 管理者 or 自社オーナー(自社メンバー)のみ。
      //   他人の電話で他人の明細を取得できないようにする(askul/delivery EFと同一の保護)。
      const caller = await getCaller(admin, body.auth_token);
      // 他人の電話で明細を引けるのは NELTEC社員の管理者のみ(委託ドライバーの管理者は不可)。
      const isAdmin = caller?.phone === phoneInput ? true : await callerIsAdmin(admin, body.auth_token);
      if (!isAdmin) {
        if (!caller || !caller.phone) return json({ error: 'forbidden (ログインが必要です)', code: 'FORBIDDEN' }, 403);
        if (caller.phone !== phoneInput) {
          // 自社オーナーのみ、自社(company一致)メンバーの明細を閲覧可
          if (!caller.is_company_owner) return json({ error: 'forbidden (自分の明細のみ閲覧できます)', code: 'FORBIDDEN' }, 403);
          const { data: tgt } = await admin.from('profiles').select('company').eq('phone', phoneInput).maybeSingle();
          if (!tgt || !caller.company || nmKey(String((tgt as any).company ?? '')) !== nmKey(caller.company)) return json({ error: 'forbidden', code: 'FORBIDDEN' }, 403);
        }
      }
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
        phone: s.phone,
        biz_type: s.biz_type,
        company_name: s.company_name,
        primary_area: s.primary_area,
        am_sum: s.am_sum,
        pm_sum: s.pm_sum,
        planner_allowance: s.planner_allowance ?? 0,
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
