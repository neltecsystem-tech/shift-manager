#
#  poller.py - タグの位置を取得して key-tag EF(ingest) に送る (GitHub Actions実行)
#  実行時、GoogleFindMyTools のディレクトリ直下にコピーされる想定。secrets.json は Auth/ に配置済み。
#
#  環境変数:
#    INGEST_URL    : https://<ref>.supabase.co/functions/v1/key-tag
#    INGEST_SECRET : EFの KEY_TAG_INGEST_SECRET と同じ共有秘密
#    KEY_TAG_IDS   : (任意) 追跡するcanonicIdをカンマ区切り。未指定なら名前に "tag" を含むデバイスを自動追跡
#    LOCATE_TIMEOUT: (任意) 1タグの待機秒(既定90)
#
import os, sys, io, re, json, threading, contextlib, urllib.request, urllib.error
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from NovaApi.ListDevices.nbe_list_devices import request_device_list
from ProtoDecoders.decoder import parse_device_list_protobuf, get_canonic_ids
from SpotApi.UploadPrecomputedPublicKeyIds.upload_precomputed_public_key_ids import refresh_custom_trackers
from NovaApi.ExecuteAction.LocateTracker.location_request import get_location_data_for_device

INGEST_URL = os.environ.get("INGEST_URL", "").strip()
INGEST_SECRET = os.environ.get("INGEST_SECRET", "").strip()
KEY_TAG_IDS = [x.strip() for x in os.environ.get("KEY_TAG_IDS", "").split(",") if x.strip()]
LOCATE_TIMEOUT = int(os.environ.get("LOCATE_TIMEOUT", "90"))

LAT = re.compile(r"Latitude:\s*(-?\d+\.?\d*)")
LNG = re.compile(r"Longitude:\s*(-?\d+\.?\d*)")
ALT = re.compile(r"Altitude:\s*(-?\d+)")
TIM = re.compile(r"Time:\s*([\d\-]+\s[\d:]+)")
STA = re.compile(r"Status:\s*(\d+)")
OWN = re.compile(r"Is Own Report:\s*(True|False)")


def locate_capture(cid, name):
    buf = io.StringIO()
    done = threading.Event()

    def worker():
        try:
            with contextlib.redirect_stdout(buf):
                get_location_data_for_device(cid, name)
        except SystemExit:
            pass
        except Exception as e:
            buf.write(f"\n[ERR] {e}")
        finally:
            done.set()

    threading.Thread(target=worker, daemon=True).start()
    done.wait(LOCATE_TIMEOUT)
    text = buf.getvalue()

    lats = LAT.findall(text); lngs = LNG.findall(text)
    if not lats or not lngs:
        return None
    lat = float(lats[-1]); lng = float(lngs[-1])
    alt = ALT.findall(text); tim = TIM.findall(text); sta = STA.findall(text); own = OWN.findall(text)
    reported_at = None
    if tim:
        try:
            reported_at = datetime.strptime(tim[-1], "%Y-%m-%d %H:%M:%S").isoformat()
        except Exception:
            pass
    return {
        "tag_id": cid, "tag_name": name, "lat": lat, "lng": lng,
        "altitude": int(alt[-1]) if alt else None,
        "reported_at": reported_at,
        "status": int(sta[-1]) if sta else None,
        "is_own_report": (own[-1] == "True") if own else None,
    }


def get_tag_targets(device_list):
    # 物理タグ(メーカー/モデルを持つ)を自動追跡。スマホ等(メーカー空)は除外。名前非依存。
    out = []
    for dm in device_list.deviceMetadata:
        reg = dm.information.deviceRegistration
        if not ((reg.manufacturer or "").strip() or (reg.model or "").strip()):
            continue
        try:
            cids = dm.identifierInformation.canonicIds.canonicId
            cid = cids[0].id if len(cids) else None
        except Exception:
            cid = None
        if cid:
            out.append((dm.userDefinedDeviceName or (reg.model or "").strip() or cid, cid))
    return out


def main():
    # 全体の打ち切り。FCM受信が死ぬと個々の待機を抜けても延々と粘るため、
    # ここで強制終了しないと毎時フルにActions時間を焼き続ける(無料枠の枯渇)。
    budget = int(os.environ.get("TOTAL_BUDGET", "480"))
    def _watchdog():
        print(f"打ち切り: {budget}秒を超えました。FCM受信が機能していない可能性があります。", file=sys.stderr)
        os._exit(1)
    wd = threading.Timer(budget, _watchdog); wd.daemon = True; wd.start()

    result_hex = request_device_list()
    device_list = parse_device_list_protobuf(result_hex)
    try:
        refresh_custom_trackers(device_list)
    except Exception as e:
        print(f"(refresh warn: {e})")
    canonic_ids = get_canonic_ids(device_list)
    print("devices:", [n for n, _ in canonic_ids])

    if KEY_TAG_IDS:
        targets = [(n, c) for (n, c) in canonic_ids if c in KEY_TAG_IDS]
    else:
        targets = get_tag_targets(device_list)
    if not targets:
        print("追跡対象なし"); return

    positions = []
    for name, cid in targets:
        loc = locate_capture(cid, name)
        if loc:
            print(f"{name}: {loc['lat']},{loc['lng']} ({loc.get('reported_at')})")
            positions.append(loc)
        else:
            print(f"{name}: 位置なし(タイムアウト/未報告)")

    if not positions:
        # 1件も取れないのは異常(FCM受信が落ちている等)。ここで正常終了すると
        # ワークフローが緑のまま何日も位置が止まり、誰も気付けない。
        print(f"送信対象なし: {len(targets)}個すべてで位置を取得できませんでした。"
              " Google認証(secrets.json)かFCM受信の異常が疑われます。", file=sys.stderr)
        sys.exit(1)
    if not (INGEST_URL and INGEST_SECRET):
        print("INGEST未設定:", json.dumps(positions, ensure_ascii=False)); return

    body = json.dumps({"action": "ingest", "secret": INGEST_SECRET, "positions": positions}).encode()
    req = urllib.request.Request(INGEST_URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        print("ingest:", urllib.request.urlopen(req, timeout=30).read().decode()[:200])
    except urllib.error.HTTPError as e:
        print("ingest HTTP", e.code, e.read().decode()[:300], file=sys.stderr); sys.exit(1)
    except Exception as e:
        print("ingest 失敗:", e, file=sys.stderr); sys.exit(1)

    # 一部しか取れていない場合も残しておく(全滅でなくても劣化に気付けるように)
    if len(positions) < len(targets):
        print(f"注意: {len(targets)}個中 {len(positions)}個しか取得できていません。", file=sys.stderr)


if __name__ == "__main__":
    main()
