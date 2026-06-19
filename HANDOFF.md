# Shift Manager (新聞シフト管理) 引き継ぎノート

別マシンで作業を続けるための引き継ぎ。最終更新 2026-06-19。

## 概要・スタック
- 新聞(東京即売 城北/川崎高津/川越/立川 等)のシフト・請求書・収支・支払明細・店舗マスタ管理ツール。
- **静的サイト**(`index.html` / `data.js` / `js/`)。ビルド不要(フレームワーク無)。
- Supabase = **workchat (nccognptoprhwsbjnwcu)**(NexPort/会計と共通)。Supabaseキー・Google Sheets連携キーは **index.html / js 内に記述**(.env なし)。
- GitHub: `neltecsystem-tech/shift-manager`。

## Macでの立ち上げ
1. `git clone https://github.com/neltecsystem-tech/shift-manager.git`
2. ローカル確認は `index.html` をブラウザで開く(or `npx serve .` 等の簡易サーバ)。npm install 不要。

## デプロイ
- **`git push origin main` で自動公開**(GitHub Pages系)。ビルド工程なし。

## 重要な運用ルール
- **シフト系の表示は必ず Google Sheets から live 取得**(キャッシュは致命的・常時最新化)。
- 日本語表示が変な時はまずブラウザ自動翻訳(Edge等)を疑う。
- 管理画面内アクションでは password 再入力を求めない(adminAuthed判定でOK)。
- 支払明細/closed_pay_statements が会計アプリの新聞自動入力ソース(workchat内)。

## 関連EF
- `invoice-sheet`(請求/確定売上), `save-pay-statement`, `pay-statement-by-phone` 等(workchatにデプロイ。ソースの所在に注意=一部はリポ外)。
