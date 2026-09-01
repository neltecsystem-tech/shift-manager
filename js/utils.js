// shift-manager 共通ユーティリティ
// 純粋関数のみ。モジュール固有の状態 (smData, DB, smColMap 等) には触れない。
// classic script として読み込まれるため、ここで宣言した関数/定数は全てグローバル。

// ──────────────────────────────────────────────────────────────
// データ変換 / デコード
// ──────────────────────────────────────────────────────────────

function b64utf8(b){const n=atob(b),a=new Uint8Array(n.length);for(let i=0;i<n.length;i++)a[i]=n.charCodeAt(i);return new TextDecoder('utf-8').decode(a);}

// HTMLエスケープ (グローバル共通)。以前は一部の関数内ローカルにしか無く、
// adminRenderStaff 等から呼ぶと "escHtml is not defined" で描画がクラッシュしていた。
function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ──────────────────────────────────────────────────────────────
// 日付 / コース判定
// ──────────────────────────────────────────────────────────────

function isDateVal(v){return v&&/^0?\d{1,2}\/\d{1,2}$/.test(v);}

// 日付を YYYY-MM-DD のゼロ詰め形式に正規化する。
// 入力例: "2026/1/31", "2026-1-31", "2026/01/31" → "2026-01-31"
// 不正な入力はそのまま返す (副作用なし)。文字列比較で日付順序を保証したい場面で使う。
function normalizeDateYmd(s){
  if(!s)return '';
  const cleaned=String(s).replace(/\//g,'-').trim();
  const parts=cleaned.split('-');
  if(parts.length!==3)return cleaned;
  const[y,m,d]=parts;
  if(!/^\d+$/.test(y)||!/^\d+$/.test(m)||!/^\d+$/.test(d))return cleaned;
  return `${y}-${String(parseInt(m,10)).padStart(2,'0')}-${String(parseInt(d,10)).padStart(2,'0')}`;
}

// コース名から営業所を推定 (川崎は '川崎高津')
function areaOfCourse(c){
  if(!c)return'';
  if(c.startsWith('城北'))return'城北';
  if(c.startsWith('川越'))return'川越';
  if(c.startsWith('立川'))return'立川';
  if(c.startsWith('川崎'))return'川崎高津';
  return'';
}

// 短縮版: 川崎は '川崎' のまま (検索/バッジ用)
function ao(c){if(!c)return'';if(c.startsWith('城北'))return'城北';if(c.startsWith('川越'))return'川越';if(c.startsWith('立川'))return'立川';if(c.startsWith('川崎'))return'川崎';return'';}

// 営業所→バッジクラス
function bc(a){return{'城北':'badge-johoku','川越':'badge-kawagoe','立川':'badge-tachikawa','川崎':'badge-kawasaki'}[a]||'';}

// 検索ヒット箇所をハイライトHTMLに置換
function hl(t,q){if(!t||!q||!t.includes(q))return t;return t.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'),`<span class="highlight">${q}</span>`);}

// ──────────────────────────────────────────────────────────────
// アイコン変換 (Geocoding 精度 / ナビ判定 / Yahoo 一致度)
// ──────────────────────────────────────────────────────────────

function accuracyToIcon(t){
  return ({ROOFTOP:'◎',RANGE_INTERPOLATED:'○',GEOMETRIC_CENTER:'△',APPROXIMATE:'✕'})[t]||t||'';
}
function verdictToIcon(v){
  return ({match:'◎',partial:'△',mismatch:'✕'})[v]||v||'';
}
// アイコン or raw → 内部 kind 値 ('match'/'partial'/'mismatch')
function verifyKind(v){
  if(!v)return '';
  if(v==='◎'||v==='match')return 'match';
  if(v==='△'||v==='partial')return 'partial';
  if(v==='✕'||v==='mismatch')return 'mismatch';
  return '';
}
function yahooMatchToIcon(level){
  const n=parseInt(level);
  if(n>=6)return '◎';
  if(n>=5)return '○';
  if(n>=4)return '△';
  return '✕';
}

// ──────────────────────────────────────────────────────────────
// 店舗名 略称展開
// ──────────────────────────────────────────────────────────────

// 長い略称を先にマッチさせる
const SHOP_NAME_MAPPING=[
  ['LATF','ローソンスリーエフ'],
  ['T]7','セブンイレブン'],
  ['T]７','セブンイレブン'],
  ['T)7','セブンイレブン'],
  ['T)７','セブンイレブン'],
  ['FM','ファミリーマート'],
  ['LS','ローソンストア100'],
  ['LA','ローソン'],
  ['NL','ナチュラルローソン'],
  ['MS','ミニストップ'],
  ['SY','西友'],
  ['ＳＹ','西友'],
  ['YS','ヤマザキY'],
  ['D)','デイリーヤマザキ'],
  ['D]','デイリーヤマザキ'],
  ['西武','西武線'],
  ['F','ファミリーマート'],
  ['Ｆ','ファミリーマート'],
];
function expandShopName(name){
  if(!name)return name;
  for(const[code,full]of SHOP_NAME_MAPPING){
    if(name.startsWith(code)){
      return full+' '+name.slice(code.length).trim();
    }
  }
  return name;
}

// ──────────────────────────────────────────────────────────────
// 住所 正規化 / 比較
// ──────────────────────────────────────────────────────────────

function smNormalizeAddr(s){
  if(!s)return '';
  return String(s)
    .replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0))  // 全角→半角数字
    .replace(/[‐‒–—―−ｰー]/g,'-')                                          // ダッシュ統一
    .replace(/[ 　\s]+/g,'')                                                  // スペース除去
    .replace(/^〒\d{3}-?\d{4}/,'')
    .replace(/^日本、?/,'')
    .trim();
}

function smCompareAddr(a,b){
  const na=smNormalizeAddr(a);
  const nb=smNormalizeAddr(b);
  if(!na||!nb)return {kind:'mismatch',score:0};
  if(na===nb)return {kind:'match',score:100};
  // 包含関係 (片方が他方を含む)
  if(na.includes(nb)||nb.includes(na))return {kind:'match',score:95};
  // 市区町村まで一致
  const cityRe=/^(.{2,3}[都道府県])?(.{1,15}?[市区町村])/;
  const ma=na.match(cityRe);
  const mb=nb.match(cityRe);
  const cityA=ma?(ma[1]||'')+(ma[2]||''):'';
  const cityB=mb?(mb[1]||'')+(mb[2]||''):'';
  if(cityA&&cityB&&cityA===cityB){
    // 丁目まで取れるか
    const choumeRe=/^(.{2,3}[都道府県])?(.{1,15}?[市区町村])(.{1,20}?\d+丁目)?/;
    const ca=na.match(choumeRe);
    const cb=nb.match(choumeRe);
    const cha=ca?[ca[1]||'',ca[2]||'',ca[3]||''].join(''):'';
    const chb=cb?[cb[1]||'',cb[2]||'',cb[3]||''].join(''):'';
    if(cha&&chb&&cha===chb)return {kind:'match',score:85};
    return {kind:'partial',score:50};
  }
  return {kind:'mismatch',score:0};
}

// ──────────────────────────────────────────────────────────────
// 名前正規化 (請求書: 全角/半角空白を全削除して比較)
// ──────────────────────────────────────────────────────────────

// 氏名の異体字 (同じ字の別の書き方)。シフト表・単価マスタ・人員名簿で書き分けられており、
// 1文字違うだけで別人扱いになって支払いや売上が丸ごと0になる事故が繰り返し起きている。
//   例: 単価マスタ「齋藤　一輝」/ 7月シフト表「斉藤　一輝」→ 社員の担当売上が0日・0円になっていた
// ここは「読みも人も同じで字体だけ違う」ものに限る。読みが変わる置き換えは入れない。
const INV_NAME_VARIANTS={
  '齋':'斉','斎':'斉','齊':'斉',
  '髙':'高','﨑':'崎','嵜':'崎',
  '濵':'浜','濱':'浜','邊':'辺','邉':'辺',
  '澤':'沢','瀨':'瀬','眞':'真','德':'徳',
  '冨':'富','栁':'柳','郞':'郎','薗':'園','曻':'昇',
};
// 🚨 屋号と氏名の区切り記号は無視する(2026-09-01)。
// 2026-08-13 に単価マスタを「屋号/氏名」表記へ統一した際、特別日当シートの氏名が旧表記
// (TLC.ﾊﾟｰﾄﾅｰｽﾞ㈱)のまま残り、単価マスタ(TLC/ﾊﾟｰﾄﾅｰｽﾞ㈱)と一致せず、日曜の特別日当
// 7,000円×5週が請求・支払に乗らなくなっていた。区切りが . / ／ ・ のどれでも同じ人として
// 扱えば、今後どの表記へ統一しても金額が落ちない。
function invNormName(n){
  return String(n||'')
    .replace(/[\s　 ]+/g,'')
    .replace(/[.．/／・]+/g,'')
    .replace(/[齋斎齊髙﨑嵜濵濱邊邉澤瀨眞德冨栁郞薗曻]/g,c=>INV_NAME_VARIANTS[c]||c)
    .trim();
}

// ──────────────────────────────────────────────────────────────
// 距離計算 (Haversine, 単位: m)
// ──────────────────────────────────────────────────────────────

function msrCalcDist(lat1,lng1,lat2,lng2){
  const R=6371000;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ──────────────────────────────────────────────────────────────
// 入力デバウンス (検索ボックスの oninput 用)
// ──────────────────────────────────────────────────────────────

const _dbTimers={};
function dbInput(fnName,ms){
  ms=ms||200;
  clearTimeout(_dbTimers[fnName]);
  _dbTimers[fnName]=setTimeout(()=>{const f=window[fnName];if(typeof f==='function')f();},ms);
}
