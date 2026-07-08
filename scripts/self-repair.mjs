// 新聞ツール 自己修復ボット(PRモード)
// 毎朝の Claude 診断の後に GitHub Actions から実行される。
// 低〜中リスク & 非エスカレーションのエラーに対し、Claudeが「最小の防御的修正」(null/optional chaining/try-catch)を
// 生成 → 構文チェック → PRを作成する。人間がマージして初めて本番反映。
// 重度障害(severity=high / escalated=true)は対象外(人間対応)。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DIAG_API = 'https://nccognptoprhwsbjnwcu.supabase.co/functions/v1/diagnose-errors';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const FILE = 'index.html';
const MAX_NEW_LEN = 700;   // 生成する new_string の上限(小さな修正のみ許可)
const CONTEXT_BEFORE = 30, CONTEXT_AFTER = 18;

process.env.GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const log = (...a) => console.log('[self-repair]', ...a);
const run = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// 変更後HTMLのインラインJSを構文チェック(テンプレ内の <\/script> は正規表現にマッチしないので誤検知しない)
function checkSyntax(html) {
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const code = m[1];
    if (!code.trim()) continue;
    const f = `sr_check_${i++}.js`;
    fs.writeFileSync(f, code);
    try { execSync(`node --check ${f}`, { stdio: 'pipe' }); }
    catch (e) { log('構文NG:', (e.stderr || e.stdout || '').toString().slice(0, 300)); fs.rmSync(f, { force: true }); return false; }
    fs.rmSync(f, { force: true });
  }
  return true;
}

async function askClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error('Claude API ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const jr = await r.json();
  const text = (jr.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('修正JSON抽出失敗');
  return JSON.parse(m[0]);
}

async function main() {
  if (!ANTHROPIC_API_KEY) { log('ANTHROPIC_API_KEY 未設定。終了。'); return; }

  // 1) 最新診断 + エラー集約を取得
  const res = await fetch(DIAG_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'summary', app: 'shift-manager' }) });
  const data = await res.json();
  const latest = data.latest;
  const groups = data.groups || [];
  if (!latest || !Array.isArray(latest.items)) { log('診断がまだありません。何もしません。'); return; }

  // 2) 対象: 低〜中リスク & 非エスカレーション & 自己修復未済 が存在するか
  const actionable = (latest.items || []).filter((it) => (it.severity === 'low' || it.severity === 'medium') && !it.escalated && !it.self_healed);
  if (!actionable.length) { log('自動修正対象(低〜中リスク)がありません。'); return; }

  // 3) コード位置を特定できる group を1件だけ選ぶ(index.html:行 がスタックにあるもの・非エスカレーション)
  const target = groups.find((g) => !g.escalated && /index\.html:\d+/.test((g.sample_stack || '') + ' ' + (g.message || '')));
  if (!target) { log('修正箇所(index.html:行)を特定できるエラーがありません。安全のため何もしません。'); return; }
  const line = parseInt(((target.sample_stack || '') + ' ' + (target.message || '')).match(/index\.html:(\d+)/)[1], 10);

  // 4) 同じエラーのPRが既にあればスキップ(重複防止)
  const sig = crypto.createHash('sha1').update(target.message || '').digest('hex').slice(0, 10);
  const branch = `selfheal/${sig}`;
  try { if (run(`git ls-remote --heads origin ${branch}`).trim()) { log('既にPRブランチあり。スキップ:', branch); return; } } catch (_) {}

  // 5) コード文脈を抽出
  const html = fs.readFileSync(FILE, 'utf8');
  const lines = html.split('\n');
  const from = Math.max(0, line - CONTEXT_BEFORE), to = Math.min(lines.length, line + CONTEXT_AFTER);
  const context = lines.slice(from, to).map((l, i) => (from + i + 1) + ': ' + l).join('\n');

  // 6) Claudeに最小の防御的修正を依頼
  const prompt = `あなたは社内Webツール「新聞シフト管理(shift-manager, index.html の Vanilla JS)」の保守担当です。
本番で以下の未捕捉エラーが発生しています。**最小限かつ純粋に防御的な修正**(オプショナルチェーン ?. の付与 / null・undefinedガード / try-catch の追加)だけを提案してください。

【エラー】${target.message}(件数 ${target.count} / 画面 ${(target.views || []).join(',')})
【スタック抜粋】${target.sample_stack || '(なし)'}
【診断サマリ】${latest.summary || ''}

【該当コード(行番号つき, ${FILE})】
${context}

厳格な制約:
- 既存ロジックを変更・削除しない。ガードを足すだけ。
- 変更は index.html の**1箇所**のみ。old_string は上記コードから正確にそのままコピー(改行・インデント含む)し、**ファイル内で一意**になる十分な長さにする。
- new_string は old_string を含んだ上でガードを足した形にし、短く保つ(700文字以内)。
- 安全・最小にできない場合は必ず skip する(無理に直さない)。

次のJSONのみ返す:
{"skip":false,"title":"PRタイトル(日本語,簡潔)","rationale":"なぜ安全かの説明(日本語)","old_string":"...","new_string":"..."}
直せない場合: {"skip":true,"reason":"理由"}`;

  const fix = await askClaude(prompt);
  if (fix.skip) { log('Claudeがskip:', fix.reason); return; }
  if (!fix.old_string || !fix.new_string) { log('修正内容が不完全。スキップ。'); return; }
  if (fix.new_string.length > MAX_NEW_LEN) { log('new_stringが大きすぎ。安全のためスキップ。'); return; }

  // 7) 一意性を確認して適用
  const occurrences = html.split(fix.old_string).length - 1;
  if (occurrences !== 1) { log(`old_string が一意でない(出現${occurrences}回)。スキップ。`); return; }
  const patched = html.replace(fix.old_string, fix.new_string);
  if (patched === html) { log('置換が反映されず。スキップ。'); return; }
  fs.writeFileSync(FILE, patched);

  // 8) 構文ゲート(壊れていたら破棄してPRを作らない)
  if (!checkSyntax(patched)) { log('構文チェックNG。変更を破棄してPRは作りません。'); fs.writeFileSync(FILE, html); return; }

  // 9) ブランチ作成→commit→push→PR
  run('git config user.name "self-repair-bot"');
  run('git config user.email "self-repair-bot@users.noreply.github.com"');
  run(`git checkout -b ${branch}`);
  run(`git add ${FILE}`);
  const msg = `自己修復(自動PR): ${fix.title}`;
  execSync(`git commit -m ${JSON.stringify(msg)}`, { stdio: 'pipe' });
  run(`git push -u origin ${branch}`);
  const body = [
    '🤖 **自己修復ボットによる自動修正案（要レビュー）**', '',
    '**対象エラー**: `' + (target.message || '').slice(0, 200) + '` (件数 ' + target.count + ')',
    '', '**修正の意図**: ' + (fix.rationale || ''),
    '', '⚠️ これはAIが生成した防御的な最小修正です。**内容を確認してからマージ**してください。マージすると git push で本番反映されます。',
    '', '重度障害(認証/課金/データ破損/全面停止 or 規定回数以上の再発)は自動修正の対象外です。',
  ].join('\n');
  execSync(`gh pr create --base main --head ${branch} --title ${JSON.stringify(msg)} --body ${JSON.stringify(body)}`, { stdio: 'pipe' });
  log('PR作成完了:', branch);
}

main().catch((e) => { console.error('[self-repair] エラー:', e && e.message); process.exit(1); });
