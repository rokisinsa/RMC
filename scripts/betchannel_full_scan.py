#!/usr/bin/env python3
"""
BET CHANNEL public sportsbook exhaustive scanner.
- Opens the real public sportsbook in headless Chrome.
- Discovers every /matches?ct= category link present in the rendered sports menu.
- Visits every discovered category.
- Repeatedly expands "もっと試合を表示する" and scrolls until stable.
- Captures rendered event blocks and network JSON that expose match_id.
- Writes an evidence-backed JSON snapshot. Never guesses counts.
No login, CAPTCHA bypass, stealth, or authenticated endpoint is used.
"""
from __future__ import annotations
import argparse, json, os, re, sys, time, hashlib
from datetime import datetime, timezone, timedelta
from urllib.parse import urljoin, urlparse, parse_qs

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.common.exceptions import WebDriverException, StaleElementReferenceException

BASE = "https://bet-channel.com"
ROOT = BASE + "/matches?lang=ja"
JST = timezone(timedelta(hours=9))

def now_jst():
    return datetime.now(JST).isoformat(timespec="seconds")

def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip()

def stable_id(parts):
    raw = "|".join(norm(str(x)).lower() for x in parts if x is not None)
    return "bc-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]

def make_driver():
    o = Options()
    o.add_argument("--headless=new")
    o.add_argument("--no-sandbox")
    o.add_argument("--disable-dev-shm-usage")
    o.add_argument("--disable-gpu")
    o.add_argument("--window-size=1600,1200")
    o.add_argument("--lang=ja-JP")
    o.add_argument("--disable-notifications")
    o.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    return webdriver.Chrome(options=o)

def wait_ready(d, seconds=20):
    end = time.time() + seconds
    last = ""
    stable = 0
    while time.time() < end:
        try:
            cur = d.execute_script("return document.body ? document.body.innerText : ''")
        except Exception:
            cur = ""
        if cur and cur == last:
            stable += 1
            if stable >= 3:
                return
        else:
            stable = 0
            last = cur
        time.sleep(1)

def expand_all(d, max_rounds=80):
    clicks = 0
    last_height = 0
    stable_rounds = 0
    for _ in range(max_rounds):
        d.execute_script("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(0.5)
        clicked = False
        candidates = d.find_elements(By.XPATH, "//*[self::button or self::a or self::div or self::span][contains(normalize-space(.),'もっと試合を表示する')]")
        for el in candidates:
            try:
                if el.is_displayed() and el.is_enabled():
                    d.execute_script("arguments[0].click()", el)
                    clicks += 1
                    clicked = True
                    time.sleep(1.2)
                    break
            except (StaleElementReferenceException, WebDriverException):
                pass
        h = d.execute_script("return document.body.scrollHeight")
        if not clicked and h == last_height:
            stable_rounds += 1
        else:
            stable_rounds = 0
        last_height = h
        if stable_rounds >= 3:
            break
    return clicks

def category_links(d):
    out = {}
    for a in d.find_elements(By.CSS_SELECTOR, "a[href*='/matches?ct='], a[href*='/matches?'][href*='ct=']"):
        try:
            href = a.get_attribute("href")
            label = norm(a.text)
        except StaleElementReferenceException:
            continue
        if not href:
            continue
        q = parse_qs(urlparse(href).query)
        ct = (q.get("ct") or [None])[0]
        if not ct:
            continue
        url = href if "lang=" in href else href + ("&" if "?" in href else "?") + "lang=ja"
        out[ct] = {"ct": ct, "label": label or f"ct={ct}", "url": url}
    return sorted(out.values(), key=lambda x: (int(x["ct"]) if str(x["ct"]).isdigit() else 10**9, x["ct"]))

def text_event_candidates(body_text, category_label):
    lines = [norm(x) for x in (body_text or "").splitlines()]
    lines = [x for x in lines if x]
    events = []
    date_re = re.compile(r"^(?:\d{1,2}月\d{1,2}日|\d{1,2}/\d{1,2})\s+\d{1,2}:\d{2}")
    for i, line in enumerate(lines):
        if date_re.search(line) and ("試合開始" in line or "ベット締切" in line):
            title = ""
            for j in range(i + 1, min(i + 6, len(lines))):
                v = lines[j]
                if not any(k in v for k in ["試合情報","オッズ","ベット受付中","HOME","AWAY","ベット締切"]):
                    title = v
                    break
            eid = stable_id([category_label, line, title])
            events.append({"event_id": eid, "time_line": line, "title": title, "source": "rendered_dom"})
    return events

def network_events(d):
    events = {}
    logs = []
    try:
        logs = d.get_log("performance")
    except Exception:
        return []
    for item in logs:
        try:
            msg = json.loads(item["message"])["message"]
            if msg.get("method") != "Network.responseReceived":
                continue
            p = msg["params"]
            resp = p.get("response", {})
            mime = (resp.get("mimeType") or "").lower()
            if "json" not in mime:
                continue
            req_id = p.get("requestId")
            body = d.execute_cdp_cmd("Network.getResponseBody", {"requestId": req_id}).get("body", "")
            if len(body) > 8_000_000:
                continue
            data = json.loads(body)
        except Exception:
            continue
        stack = [data]
        while stack:
            x = stack.pop()
            if isinstance(x, dict):
                mid = x.get("match_id") or x.get("matchId") or x.get("id") if any(k in x for k in ("match_id","matchId")) else None
                if mid is not None:
                    title = x.get("band_name") or x.get("match_name") or x.get("name") or x.get("title") or ""
                    start = x.get("game_start_date") or x.get("start_at") or x.get("game_start_time") or ""
                    eid = "bc-match-" + str(mid)
                    events[eid] = {"event_id": eid, "provider_match_id": str(mid), "title": norm(str(title)), "start": norm(str(start)), "source": "network_json"}
                stack.extend(x.values())
            elif isinstance(x, list):
                stack.extend(x)
    return list(events.values())

def scan_page(d, item):
    row = {**item, "checked_at": now_jst(), "status": "ok", "load_more_clicks": 0, "event_ids": [], "events": [], "body_sha256": None, "error": None}
    try:
        d.get(item["url"])
        wait_ready(d)
        row["load_more_clicks"] = expand_all(d)
        wait_ready(d, 8)
        body = d.find_element(By.TAG_NAME, "body").text
        row["body_sha256"] = hashlib.sha256(body.encode("utf-8", "ignore")).hexdigest()
        by_id = {}
        for e in network_events(d) + text_event_candidates(body, item["label"]):
            by_id[e["event_id"]] = e
        row["events"] = list(by_id.values())
        row["event_ids"] = sorted(by_id)
        # Hard block/access detection.
        lower = body.lower()
        if any(x in lower for x in ["access denied", "forbidden", "captcha", "cloudflare ray id"]):
            row["status"] = "blocked"
            row["error"] = "access-block page detected"
    except Exception as e:
        row["status"] = "error"
        row["error"] = f"{type(e).__name__}: {e}"
    return row

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/betchannel-scan.json")
    ap.add_argument("--max-categories", type=int, default=0, help="0 = all (production); nonzero only for local diagnostics")
    args = ap.parse_args()

    started = now_jst()
    d = make_driver()
    try:
        d.get(ROOT)
        wait_ready(d)
        expand_all(d, 10)
        root_body = d.find_element(By.TAG_NAME, "body").text
        cats = category_links(d)
        menu_end_verified = "その他スポーツ" in root_body and len(cats) > 0
        if args.max_categories:
            cats = cats[:args.max_categories]
        scans = []
        all_events = {}
        for idx, c in enumerate(cats, 1):
            print(f"[{idx}/{len(cats)}] {c['ct']} {c['label']}", flush=True)
            row = scan_page(d, c)
            scans.append(row)
            for e in row["events"]:
                all_events[e["event_id"]] = {**e, "category_ct": c["ct"], "category_label": c["label"]}
        failed = [x for x in scans if x["status"] != "ok"]
        result = {
            "schema_version": 1,
            "source": "BET CHANNEL public sportsbook",
            "root_url": ROOT,
            "started_at": started,
            "finished_at": now_jst(),
            "access_status": "direct" if not failed else "partial",
            "menu_end_verified": bool(menu_end_verified),
            "category_count": len(cats),
            "categories": scans,
            "failed_category_count": len(failed),
            "failed_categories": [{"ct":x["ct"],"label":x["label"],"status":x["status"],"error":x["error"]} for x in failed],
            "event_count": len(all_events),
            "event_ids": sorted(all_events),
            "events": sorted(all_events.values(), key=lambda x: x["event_id"]),
            "complete": bool(menu_end_verified and cats and not failed),
            "completeness_rule": "menu_end_verified && category_count>0 && failed_category_count==0; event_count is derived only from unique event_ids",
            "note": "Counts are derived from collected IDs only. No guessed category or event counts."
        }
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fp:
            json.dump(result, fp, ensure_ascii=False, indent=2)
            fp.write("\n")
        print(json.dumps({k:result[k] for k in ["complete","access_status","menu_end_verified","category_count","failed_category_count","event_count"]}, ensure_ascii=False))
        if not result["complete"]:
            sys.exit(2)
    finally:
        d.quit()

if __name__ == "__main__":
    main()
