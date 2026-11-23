#!/usr/bin/env python3
"""Download daily HOSE prices for PNJ and write the blog chart data.

Source: Yahoo Finance chart API (no API key, stdlib only).

  PNJ.VN  Phu Nhuan Jewelry (CTCP Vang bac Da quy Phu Nhuan)

Writes:
  blog/data/pnj-daily.json
  blog/data/pnj-daily.js     (window.PNJDAILY = ...; loaded by the post)

Quoted closes are the HOSE board prices in VND. Yahoo's close is already
adjusted for the 2:1 share bonus (ex-date 2026-04-23, a 3:2 split). This
script puts that adjustment back (close * 3/2, snapped to the HOSE tick)
for sessions before the ex-date. Adjusted closes are Yahoo's adjclose,
rounded to 0.01 VND. Yahoo also split-adjusts the 1,000 VND cash dividend
(ex-date 2026-01-09) down to 666.67 VND, and adjclose before that date
includes it.

The page plots adjusted closes and marks 1 July 2026 (the buyback wave),
21 October 2026 (extraordinary general meeting) and 21 November 2026
(the revised buyback schedule).
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ICT = timezone(timedelta(hours=7))
# 2026-01-01 00:00 ICT through the session of 2026-11-23.
PERIOD1 = int(datetime(2026, 1, 1, tzinfo=ICT).timestamp())
PERIOD2 = int(datetime(2026, 11, 24, tzinfo=ICT).timestamp())
SPLIT_EX = "2026-04-23"
BONUS_NUM = 3
BONUS_DEN = 2
OUT_DIR = Path(__file__).resolve().parent


def fetch(symbol: str) -> tuple[dict, list[dict], dict]:
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{symbol}?period1={PERIOD1}&period2={PERIOD2}"
        "&interval=1d&events=div%7Csplit&includeAdjustedClose=true"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.load(response)
    result = payload["chart"]["result"][0]
    meta = result.get("meta") or {}
    if meta.get("currency") != "VND":
        raise SystemExit(f"{symbol}: expected VND, got {meta.get('currency')}")
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
        volume = quote["volume"][index]
        rows.append(
            {
                "date": day,
                "close": float(close),
                "adj": float(adj),
                "volume": None if volume is None else int(volume),
            }
        )
    if not rows:
        raise SystemExit(f"{symbol}: no rows")
    events = result.get("events") or {}
    return meta, rows, events


def tick_size(price: float) -> int:
    if price >= 50000:
        return 100
    if price >= 10000:
        return 50
    return 10


def quoted(row: dict) -> int:
    raw = row["close"]
    if row["date"] < SPLIT_EX:
        raw = raw * BONUS_NUM / BONUS_DEN
    tick = int(round(raw / tick_size(raw))) * tick_size(raw)
    if abs(raw - tick) > 1:
        raise SystemExit(f"PNJ {row['date']}: {raw} is not on a HOSE tick")
    return tick


def event_rows(events: dict) -> dict:
    dividends = []
    for item in (events.get("dividends") or {}).values():
        day = datetime.fromtimestamp(item["date"], ICT).date().isoformat()
        dividends.append({"date": day, "amount_vnd": item.get("amount")})
    splits = []
    for item in (events.get("splits") or {}).values():
        day = datetime.fromtimestamp(item["date"], ICT).date().isoformat()
        splits.append(
            {
                "date": day,
                "numerator": item.get("numerator"),
                "denominator": item.get("denominator"),
            }
        )
    dividends.sort(key=lambda item: item["date"])
    splits.sort(key=lambda item: item["date"])
    return {"dividends": dividends, "splits": splits}


def main() -> None:
    meta, raw, events = fetch("PNJ.VN")
    series = [
        {
            "date": row["date"],
            "close": quoted(row),
            "adj": round(row["adj"], 2),
            "volume": row["volume"],
        }
        for row in raw
    ]
    adjustments = event_rows(events)
    document = {
        "source": "Yahoo Finance chart API",
        "url": "https://query1.finance.yahoo.com/v8/finance/chart/PNJ.VN",
        "symbol": "PNJ.VN",
        "currency": "VND",
        "timezone": "Asia/Saigon",
        "fetched_at": datetime.now(ICT).isoformat(timespec="seconds"),
        "exchange": meta.get("exchangeName"),
        "first_date": series[0]["date"],
        "last_date": series[-1]["date"],
        "markers": [
            {
                "date": "2026-07-01",
                "label": "Đầu tháng 7",
                "note": "Tháng khách mang kim cương bán lại tăng mạnh.",
            },
            {
                "date": "2026-10-21",
                "label": "ĐHĐCĐ",
                "note": "Đại hội bất thường thông qua dự phòng và phát hành riêng lẻ.",
            },
            {
                "date": "2026-11-21",
                "label": "Đổi lịch thu đổi",
                "note": "Lịch thanh toán mới áp dụng từ 21/11. Thứ Bảy, không có phiên.",
            },
        ],
        "adjustments": {
            "cash_dividend": {
                "ex_date": "2026-01-09",
                "board_vnd": 1000,
                "yahoo_amount_vnd": adjustments["dividends"],
                "note": (
                    "Cash dividend 1,000 VND per share. Yahoo stores 1,000 * 2/3 "
                    "because the later share bonus is already in the series. "
                    "Adjusted close before the ex-date includes it. Quoted close does not."
                ),
            },
            "share_bonus": {
                "ex_date": SPLIT_EX,
                "ratio": "2:1",
                "yahoo_split": "3:2",
                "note": (
                    "Share bonus: 2 shares receive 1 new share. "
                    "Quoted close before the ex-date is Yahoo close * 3/2, snapped to the HOSE tick. "
                    "Adjusted close is Yahoo adjclose."
                ),
            },
        },
        "rows": series,
    }

    json_path = OUT_DIR / "pnj-daily.json"
    js_path = OUT_DIR / "pnj-daily.js"
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    json_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js_path.write_text("window.PNJDAILY = " + text + ";\n", encoding="utf-8")
    print(
        f"wrote {json_path.name} and {js_path.name}: "
        f"{len(series)} sessions, {document['first_date']} → {document['last_date']}, "
        f"{document['fetched_at']}"
    )
    print("events", json.dumps(adjustments, ensure_ascii=False))
    print("meta_keys", sorted(meta.keys()))


if __name__ == "__main__":
    main()
