#!/usr/bin/env python3
"""Download daily HOSE prices for SGN and VJC and write the blog chart data.

Source: Yahoo Finance chart API (no API key, stdlib only).

  SGN.VN  Sai Gon Ground Services (SAGS)
  VJC.VN  VietJet Aviation

Writes:
  blog/data/sgn-vjc-daily.json
  blog/data/sgn-vjc-daily.js     (window.SGNVJC = ...; loaded by the post)

Quoted closes are the HOSE board prices in VND. Yahoo's close for VJC.VN is
already adjusted for the 100:30 stock dividend (ex-date 2026-06-16). This
script puts that adjustment back (close * 130/100, snapped to the 100-VND
tick) for sessions before the ex-date. Adjusted closes are Yahoo's adjclose,
rounded to 0.01 VND. The page indexes those adjusted closes to 100 on
2025-04-18, the last session before the 20 April 2025 handover.
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ICT = timezone(timedelta(hours=7))
# 2024-10-01 00:00 ICT through the session of 2026-10-23.
PERIOD1 = int(datetime(2024, 10, 1, tzinfo=ICT).timestamp())
PERIOD2 = int(datetime(2026, 10, 24, tzinfo=ICT).timestamp())
VJC_SPLIT_EX = "2026-06-16"
VJC_SPLIT_NUM = 130
VJC_SPLIT_DEN = 100
INDEX_BASE = "2025-04-18"
OUT_DIR = Path(__file__).resolve().parent


def fetch(symbol: str) -> list[dict]:
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{symbol}?period1={PERIOD1}&period2={PERIOD2}"
        "&interval=1d&events=div%7Csplit&includeAdjustedClose=true"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.load(response)
    result = payload["chart"]["result"][0]
    if result.get("meta", {}).get("currency") != "VND":
        raise SystemExit(f"{symbol}: expected VND, got {result.get('meta')}")
    timestamps = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    adjusted = result["indicators"]["adjclose"][0]["adjclose"]
    rows = []
    for index, stamp in enumerate(timestamps):
        close = quote["close"][index]
        adj = adjusted[index]
        if close is None or adj is None:
            continue
        day = datetime.fromtimestamp(stamp, ICT).date().isoformat()
        rows.append({"date": day, "close": float(close), "adj": float(adj)})
    if not rows:
        raise SystemExit(f"{symbol}: no rows")
    return rows


def vjc_quoted(row: dict) -> int:
    raw = row["close"]
    if row["date"] < VJC_SPLIT_EX:
        raw = raw * VJC_SPLIT_NUM / VJC_SPLIT_DEN
    tick = int(round(raw / 100.0)) * 100
    if abs(raw - tick) > 1:
        raise SystemExit(f"VJC {row['date']}: {raw} is not on a 100-VND tick")
    return tick


def sgn_quoted(row: dict) -> int:
    tick = int(round(row["close"]))
    if tick % 100 != 0:
        raise SystemExit(f"SGN {row['date']}: close {row['close']} is not a 100-VND tick")
    return tick


def main() -> None:
    sgn = {row["date"]: row for row in fetch("SGN.VN")}
    vjc = {row["date"]: row for row in fetch("VJC.VN")}
    if INDEX_BASE not in sgn or INDEX_BASE not in vjc:
        raise SystemExit(f"missing index base session {INDEX_BASE}")

    dates = sorted(set(sgn) | set(vjc))
    series = []
    for day in dates:
        s = sgn.get(day)
        v = vjc.get(day)
        series.append(
            {
                "date": day,
                "sgn_close": None if s is None else sgn_quoted(s),
                "sgn_adj": None if s is None else round(s["adj"], 2),
                "vjc_close": None if v is None else vjc_quoted(v),
                "vjc_adj": None if v is None else round(v["adj"], 2),
            }
        )

    base_sgn = next(row for row in series if row["date"] == INDEX_BASE)
    base_vjc_adj = base_sgn["vjc_adj"]
    document = {
        "source": "Yahoo Finance chart API",
        "url": "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
        "symbols": {"SGN": "SGN.VN", "VJC": "VJC.VN"},
        "currency": "VND",
        "timezone": "Asia/Saigon",
        "fetched_at": datetime.now(ICT).isoformat(timespec="seconds"),
        "first_date": series[0]["date"],
        "last_date": series[-1]["date"],
        "index_base_date": INDEX_BASE,
        "index_base": {
            "date": INDEX_BASE,
            "note": "Last HOSE session before the 20 April 2025 handover at 00:00 ICT.",
            "sgn_adj": base_sgn["sgn_adj"],
            "vjc_adj": base_vjc_adj,
        },
        "annotation_date": "2025-04-20",
        "adjustments": {
            "SGN": {
                "yahoo_dividend_vnd": 2500,
                "ex_date": "2025-11-07",
                "note": "Cash dividend. Quoted close is Yahoo close. Adjusted close is Yahoo adjclose.",
            },
            "VJC": {
                "stock_dividend": "100:30",
                "ex_date": VJC_SPLIT_EX,
                "note": (
                    "Yahoo records a 130:100 split on the ex-date. "
                    "Quoted close before that date is adjclose * 130/100, snapped to 100 VND. "
                    "Adjusted close is Yahoo adjclose."
                ),
            },
        },
        "rows": series,
    }

    json_path = OUT_DIR / "sgn-vjc-daily.json"
    js_path = OUT_DIR / "sgn-vjc-daily.js"
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    json_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js_path.write_text("window.SGNVJC = " + text + ";\n", encoding="utf-8")
    print(f"wrote {json_path.name} and {js_path.name}: {len(series)} sessions, {document['fetched_at']}")


if __name__ == "__main__":
    main()
