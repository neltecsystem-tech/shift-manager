# Shift Manager (新聞シフト管理) 引き継ぎノート

別マシンで作業を続けるための引き継ぎ。最終更新 2026-06-26。

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
- `shop-master`(店舗マスタCRUD/順番自動採番), `cleanup-closed-shops`(閉店cron) もこのリポ `supabase/functions/` にソースあり。
- **EFデプロイは Supabase PAT が必要**(MCPは読み取り専用)。`SUPABASE_ACCESS_TOKEN=<PAT> supabase functions deploy <fn> --project-ref nccognptoprhwsbjnwcu --no-verify-jwt`。

## 最近の作業 (2026-06-25〜26)
- **店舗マスタの「順番」は店着時間順で自動採番**される設計と判明(shop-master EF の `reorderEdition` が add/update のたびに再採番)。順番を手書きしても次の編集で上書きされる。区分別固定列: 朝刊 course=5/order=12/time=13, 夕刊 14/17/18, 競馬 19/23/24。
- 新店追加・編集の **「↕ 間に挿入」を店着時間ベースに作り替え**(`smInsertOrder`/`smPickInsertSlot`/`smApplyTimeShift`/`SM_EDITIONS`)。両隣の店着時間Gと座標から区間移動時間を自己校正して新店時間を算出、迂回増分を後続店舗の店着時間に加算(後ろ倒し)。順番はEFに委譲。
- **閉店cron `cleanup-closed-shops`** に、コース名クリア後の順番詰め直し(店着時間順1..N)を追加し**デプロイ済**。
- **測定画面に相乗りナビ地図**(`msrToggleMap`系: 順路+現在地追従, Leaflet/OSM, 既存の watchPosition 1本を共有)。**ダイヤグラム地図にGPS追従**(`diagToggleGps`系, 閉じるとclearWatch)。
- **管理→測定データ**: 「🗓 全期間」で日付解除→担当者ごとの全履歴表示、「⬇ CSV出力」追加(`admMsrAllPeriod`/`admMsrExport`/`admMsrGroups`)。
- **「📢 更新履歴」ページ新規**(`view-changelog` / `CHANGELOG`配列 / `renderChangelog`)。新機能を足したら配列先頭に追記。**manual.html も同時更新**(2-7/2-9/2-10/2-11/3-14 と目次)。
- 詳細は Windows 側 Claude の auto-memory `project_shopmaster_ordering` 参照。
