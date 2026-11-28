"""
盤後零股實戰看板 — 5 年真實歷史回測 & 分段滾動引擎
1. 採用 adjclose 還原除權息價格計算指標與報酬（等比例還原 open/high/low）
2. 支援透過 GAS API 讀取即時 Watchlist，若未提供則使用預設 100 檔清單
3. 嚴格套用盤後零股策略：C01/C08/C09 + 共振買點 + 三批加碼 + 移動停利/時間停損/硬停損
4. 零股成本模型：6折手續費 (0.0855%, 最低 1 元) + 證交稅 (個股 0.3%, 00開頭ETF 0.1%)
5. 產出 5 年連續複利 (Q1~Q20)、樣本內/樣本外對比，以及 3 個月(20期) / 6 個月(10期) 獨立起點分段回滾實測
"""

import argparse
import concurrent.futures
import json
import math
import os
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

# 與 gas/Code.gs getDefault100Watchlist() 一致
DEFAULT_WATCHLIST = [
    ("0050", "元大台灣50", "原型ETF", "TWSE", "穩健"),
    ("006208", "富邦台50", "原型ETF", "TWSE", "穩健"),
    ("0056", "元大高股息", "原型ETF", "TWSE", "穩健"),
    ("00878", "國泰永續高股息", "原型ETF", "TWSE", "穩健"),
    ("00919", "群益台灣精選高息", "原型ETF", "TWSE", "穩健"),
    ("00713", "元大台灣高息低波", "原型ETF", "TWSE", "穩健"),
    ("00929", "復華台灣科技優息", "原型ETF", "TWSE", "穩健"),
    ("0052", "富邦科技", "原型ETF", "TWSE", "穩健"),
    ("00881", "國泰台灣5G+", "原型ETF", "TWSE", "穩健"),
    ("00631L", "元大台灣50正2", "槓桿觀察", "TWSE", "觀察"),
    ("2330", "台積電", "半導體", "TWSE", "穩健"),
    ("2454", "聯發科", "半導體", "TWSE", "穩健"),
    ("2303", "聯電", "半導體", "TWSE", "穩健"),
    ("3711", "日月光投控", "半導體", "TWSE", "穩健"),
    ("3034", "聯詠", "半導體", "TWSE", "穩健"),
    ("2379", "瑞昱", "半導體", "TWSE", "穩健"),
    ("3008", "大立光", "光學鏡頭", "TWSE", "穩健"),
    ("2408", "南亞科", "記憶體", "TWSE", "觀察"),
    ("3443", "創意", "IC設計", "TWSE", "穩健"),
    ("3661", "世芯-KY", "IC設計", "TWSE", "穩健"),
    ("5274", "信驊", "IC設計", "TPEX", "穩健"),
    ("6669", "緯穎", "AI伺服器", "TWSE", "穩健"),
    ("3037", "欣興", "PCB載板", "TWSE", "觀察"),
    ("2344", "華邦電", "記憶體", "TWSE", "觀察"),
    ("2337", "旺宏", "記憶體", "TWSE", "觀察"),
    ("3189", "景碩", "PCB載板", "TWSE", "觀察"),
    ("8046", "南電", "PCB載板", "TWSE", "觀察"),
    ("3529", "力旺", "IP矽智財", "TPEX", "穩健"),
    ("6415", "矽力*-KY", "電源IC", "TWSE", "觀察"),
    ("2449", "京元電子", "半導體封測", "TWSE", "穩健"),
    ("2317", "鴻海", "電子代工", "TWSE", "穩健"),
    ("2382", "廣達", "AI伺服器", "TWSE", "穩健"),
    ("3231", "緯創", "AI伺服器", "TWSE", "穩健"),
    ("2356", "英業達", "AI伺服器", "TWSE", "穩健"),
    ("2376", "技嘉", "AI伺服器", "TWSE", "穩健"),
    ("2377", "微星", "電腦週邊", "TWSE", "穩健"),
    ("2308", "台達電", "電源散熱", "TWSE", "穩健"),
    ("2301", "光寶科", "電源管理", "TWSE", "穩健"),
    ("2324", "仁寶", "電子代工", "TWSE", "穩健"),
    ("2357", "華碩", "電腦品牌", "TWSE", "穩健"),
    ("2395", "研華", "工業電腦", "TWSE", "穩健"),
    ("3017", "奇鋐", "散熱模組", "TWSE", "穩健"),
    ("3324", "雙鴻", "散熱模組", "TPEX", "穩健"),
    ("2421", "建準", "散熱風扇", "TWSE", "穩健"),
    ("6239", "力成", "封測", "TWSE", "穩健"),
    ("4938", "和碩", "電子代工", "TWSE", "穩健"),
    ("2353", "宏碁", "電腦品牌", "TWSE", "穩健"),
    ("2385", "群光", "電腦週邊", "TWSE", "穩健"),
    ("3533", "嘉澤", "連接器", "TWSE", "穩健"),
    ("2059", "川湖", "伺服器導軌", "TWSE", "穩健"),
    ("2345", "智邦", "網通設備", "TWSE", "穩健"),
    ("2412", "中華電", "電信防禦", "TWSE", "穩健"),
    ("3045", "台灣大", "電信防禦", "TWSE", "穩健"),
    ("4904", "遠傳", "電信防禦", "TWSE", "穩健"),
    ("3481", "群創", "面板", "TWSE", "觀察"),
    ("2409", "友達", "面板", "TWSE", "觀察"),
    ("2327", "國巨", "被動元件", "TWSE", "穩健"),
    ("2492", "華新科", "被動元件", "TWSE", "觀察"),
    ("3036", "文曄", "IC通路", "TWSE", "穩健"),
    ("3702", "大聯大", "IC通路", "TWSE", "穩健"),
    ("2313", "華通", "PCB", "TWSE", "穩健"),
    ("2368", "金像電", "PCB", "TWSE", "穩健"),
    ("6269", "台郡", "軟板PCB", "TWSE", "觀察"),
    ("6213", "聯茂", "銅箔基板", "TWSE", "觀察"),
    ("3376", "新日興", "軸承", "TWSE", "穩健"),
    ("1513", "中興電", "重電能源", "TWSE", "穩健"),
    ("1519", "華城", "重電能源", "TWSE", "穩健"),
    ("1503", "士電", "重電能源", "TWSE", "穩健"),
    ("1504", "東元", "電機機械", "TWSE", "穩健"),
    ("1605", "華新", "電線電纜", "TWSE", "觀察"),
    ("2603", "長榮", "航運", "TWSE", "穩健"),
    ("2609", "陽明", "航運", "TWSE", "觀察"),
    ("2615", "萬海", "航運", "TWSE", "觀察"),
    ("2618", "長榮航", "航空", "TWSE", "穩健"),
    ("2610", "華航", "航空", "TWSE", "穩健"),
    ("2002", "中鋼", "鋼鐵", "TWSE", "觀察"),
    ("1101", "台泥", "水泥綠能", "TWSE", "觀察"),
    ("1216", "統一", "食品消費", "TWSE", "穩健"),
    ("1301", "台塑", "塑化", "TWSE", "觀察"),
    ("1303", "南亞", "塑化", "TWSE", "觀察"),
    ("1326", "台化", "塑化", "TWSE", "觀察"),
    ("2912", "統一超", "零售百貨", "TWSE", "穩健"),
    ("9910", "豐泰", "製鞋", "TWSE", "穩健"),
    ("1476", "儒鴻", "紡織", "TWSE", "穩健"),
    ("2207", "和泰車", "汽車", "TWSE", "穩健"),
    ("2881", "富邦金", "金融", "TWSE", "穩健"),
    ("2882", "國泰金", "金融", "TWSE", "穩健"),
    ("2891", "中信金", "金融", "TWSE", "穩健"),
    ("2886", "兆豐金", "金融", "TWSE", "穩健"),
    ("2884", "玉山金", "金融", "TWSE", "穩健"),
    ("2885", "元大金", "金融", "TWSE", "穩健"),
    ("2892", "第一金", "金融", "TWSE", "穩健"),
    ("5880", "合庫金", "金融", "TWSE", "穩健"),
    ("2880", "華南金", "金融", "TWSE", "穩健"),
    ("2883", "凱基金", "金融", "TWSE", "穩健"),
    ("6446", "藥華藥", "生技", "TWSE", "穩健"),
    ("1795", "美時", "生技", "TWSE", "穩健"),
    ("4743", "合一", "生技", "TPEX", "觀察"),
    ("6472", "保瑞", "生技", "TWSE", "穩健"),
    ("1760", "寶齡富錦", "生技", "TWSE", "觀察"),
]


def calc_bot_fee(amount: float) -> int:
    return max(1, round(amount * 0.001425 * 0.6))


def calc_bot_tax(code: str, amount: float) -> int:
    rate = 0.001 if str(code).startswith("00") else 0.003
    return round(amount * rate)


def get_tick_size(p: float) -> float:
    if p < 10:
        return 0.01
    if p < 50:
        return 0.05
    if p < 100:
        return 0.1
    if p < 500:
        return 0.5
    if p < 1000:
        return 1.0
    return 5.0


def round_to_tick(p: float) -> float:
    t = get_tick_size(p)
    return round(round(p / t) * t, 2)


def load_watchlist(gas_url: Optional[str], pin: Optional[str]) -> List[Dict[str, str]]:
    if gas_url and pin:
        try:
            url = f"{gas_url}?pin={urllib.parse.quote(pin)}"
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("ok") and isinstance(data.get("watchlist"), list):
                items = []
                for w in data["watchlist"]:
                    active = w.get("Active")
                    if active is False or str(active).upper() == "FALSE":
                        continue
                    code = str(w.get("Code", "")).strip()
                    if not code:
                        continue
                    items.append({
                        "code": code,
                        "name": str(w.get("Name", code)).strip(),
                        "category": str(w.get("Category", "")).strip(),
                        "market": str(w.get("Market", "TWSE")).strip(),
                        "c02Status": str(w.get("C02_Status", "穩健")).strip() or "穩健",
                    })
                if items:
                    print(f"[INFO] Loaded {len(items)} active stocks from GAS Watchlist.")
                    return items
        except Exception as e:
            print(f"[WARN] Failed to load GAS Watchlist ({e}), falling back to default 100 stocks.")

    return [
        {"code": c, "name": n, "category": cat, "market": mkt, "c02Status": st}
        for c, n, cat, mkt, st in DEFAULT_WATCHLIST
    ]


def fetch_yahoo_history(yahoo_sym: str) -> List[Dict[str, Any]]:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_sym)}?range=6y&interval=1d"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    res = (data.get("chart") or {}).get("result")
    if not res:
        return []
    r0 = res[0]
    ts_list = r0.get("timestamp") or []
    quote = (r0.get("indicators") or {}).get("quote", [{}])[0]
    adj_list = ((r0.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or quote.get("close", [])

    bars = []
    seen_dates = set()
    tpe_tz = timezone(timedelta(hours=8))
    for i, ts in enumerate(ts_list):
        c = quote["close"][i] if i < len(quote.get("close", [])) else None
        o = quote["open"][i] if i < len(quote.get("open", [])) else None
        h = quote["high"][i] if i < len(quote.get("high", [])) else None
        l = quote["low"][i] if i < len(quote.get("low", [])) else None
        v = quote["volume"][i] if i < len(quote.get("volume", [])) else None
        adj = adj_list[i] if i < len(adj_list) and adj_list[i] is not None else c
        if c is None or o is None or h is None or l is None or v is None or c <= 0 or adj is None or adj <= 0:
            continue
        dt = datetime.fromtimestamp(ts, tpe_tz).strftime("%Y-%m-%d")
        if dt in seen_dates:
            continue
        seen_dates.add(dt)
        ratio = float(adj) / float(c)
        bars.append({
            "date": dt,
            "open": float(o) * ratio,
            "high": float(h) * ratio,
            "low": float(l) * ratio,
            "close": float(adj),
            "volume": round(float(v) / 1000.0),  # 張數，與 Code.gs 一致
        })
    return bars


def precompute_indicators(bars: List[Dict[str, Any]]) -> None:
    """預先計算所有日線技術指標與買賣訊號，加速 5 年與分段回滾模擬。"""
    n = len(bars)
    if n == 0:
        return

    ema12 = bars[0]["close"]
    ema26 = bars[0]["close"]
    dem = 0.0
    macd_hist = 0.0
    prev_macd_hist = 0.0
    k_val, d_val = 50.0, 50.0

    for i in range(n):
        b = bars[i]
        c = b["close"]
        b["sma5"] = sum(bars[j]["close"] for j in range(max(0, i - 4), i + 1)) / min(5, i + 1)
        b["sma10"] = sum(bars[j]["close"] for j in range(max(0, i - 9), i + 1)) / min(10, i + 1)
        b["sma20"] = sum(bars[j]["close"] for j in range(max(0, i - 19), i + 1)) / min(20, i + 1)
        b["sma60"] = sum(bars[j]["close"] for j in range(max(0, i - 59), i + 1)) / min(60, i + 1)
        b["avgVol5_prev"] = (
            sum(bars[j]["volume"] for j in range(max(0, i - 5), i)) / max(1, i - max(0, i - 5))
            if i >= 1 else b["volume"]
        )

        # MACD
        if i >= 1:
            ema12 = c * (2.0 / 13.0) + ema12 * (11.0 / 13.0)
            ema26 = c * (2.0 / 27.0) + ema26 * (25.0 / 27.0)
            dif = ema12 - ema26
            dem = dif * (2.0 / 10.0) + dem * (8.0 / 10.0)
            prev_macd_hist = macd_hist
            macd_hist = dif - dem
        b["macdHist"] = macd_hist
        b["prevMacdHist"] = prev_macd_hist

        # KD (9日)
        prev_k, prev_d = k_val, d_val
        if i >= 8:
            win = bars[i - 8 : i + 1]
            high9 = max(x["high"] for x in win)
            low9 = min(x["low"] for x in win)
            rsv = 50.0 if high9 == low9 else ((c - low9) / (high9 - low9)) * 100.0
            k_val = (2.0 / 3.0) * k_val + (1.0 / 3.0) * rsv
            d_val = (2.0 / 3.0) * d_val + (1.0 / 3.0) * k_val
        b["k"] = k_val
        b["d"] = d_val
        b["prevK"] = prev_k
        b["prevD"] = prev_d

        # 連漲天數
        up_streak = 0
        for j in range(i, 0, -1):
            if bars[j]["close"] > bars[j - 1]["close"]:
                up_streak += 1
            else:
                break
        b["upStreak"] = up_streak

        # 報酬率與 K 線型態
        if i >= 61:
            prev = bars[i - 1]
            prev2 = bars[i - 2]
            b["changePct"] = ((c - prev["close"]) / prev["close"]) * 100.0 if prev["close"] > 0 else 0.0
            c5 = bars[i - 5]["close"]
            b["ret5"] = ((c - c5) / c5) * 100.0 if c5 > 0 else b["changePct"]

            sma5_prev = bars[i - 1]["sma5"]
            sma20_prev = bars[i - 1]["sma20"]
            sma60_prev = bars[i - 1]["sma60"]

            b["c08"] = b["volume"] > 1000
            b["c09"] = c > b["sma20"] and c > b["sma60"] and b["sma20"] >= sma20_prev and b["sma60"] >= sma60_prev

            b3 = bars[i - 3]
            prev_max_ma = max(b3["sma5"], b3["sma10"], b3["sma20"], b3["sma60"])
            prev_min_ma = min(b3["sma5"], b3["sma10"], b3["sma20"], b3["sma60"])
            squeeze = ((prev_max_ma - prev_min_ma) / prev_min_ma) * 100.0 if prev_min_ma > 0 else 99.0
            b["c04"] = (
                squeeze <= 3.0
                and c > b["open"]
                and c > max(b["sma5"], b["sma10"], b["sma20"], b["sma60"])
                and b["volume"] > b["avgVol5_prev"] * 1.2
            )
            b["c05"] = b["prevK"] <= b["prevD"] and b["k"] > b["d"] and b["k"] <= 60 and b["d"] <= 60
            b["c06"] = (b["prevMacdHist"] <= 0 and b["macdHist"] > 0) or (
                b["macdHist"] > 0 and b["macdHist"] > b["prevMacdHist"]
            )

            body = abs(c - b["open"])
            upper_shadow = b["high"] - max(c, b["open"])
            body_mid = (b["open"] + c) / 2.0
            b["isHalfBodyUp"] = c > b["open"] and body_mid >= b["sma5"] and c > b["sma5"] and b["sma5"] >= sma5_prev
            b["isHalfBodyDown"] = c < b["open"] and body_mid <= b["sma5"] and c < b["sma5"] and b["sma5"] <= sma5_prev
            b["isBirdBeak"] = sma5_prev <= sma20_prev * 1.015 and b["sma5"] > sma5_prev and b["low"] >= b["sma20"] * 0.985 and c > b["sma5"]
            b["isBullEngulfing"] = prev["close"] < prev["open"] and c > b["open"] and b["open"] <= prev["close"] and c >= prev["open"]
            b["isMorningStar"] = (
                prev2["close"] < prev2["open"]
                and abs(prev["close"] - prev["open"]) < abs(prev2["close"] - prev2["open"]) * 0.4
                and c > b["open"]
                and c > (prev2["open"] + prev2["close"]) / 2.0
            )
            b["isHighUpperShadow"] = upper_shadow > body * 1.8 and b["volume"] > b["avgVol5_prev"] * 1.5
            b["recentLow10"] = min(bars[j]["low"] for j in range(max(0, i - 9), i + 1))
        else:
            b["changePct"] = 0.0
            b["ret5"] = 0.0
            b["c08"] = False
            b["c09"] = False


def compute_risk_metrics(equity_series: List[float], trading_days: int) -> Dict[str, float]:
    if len(equity_series) < 2:
        return {"cagrPct": 0.0, "volPct": 0.0, "sharpe": 0.0, "sortino": 0.0, "calmar": 0.0, "mddPct": 0.0}
    daily_rets = [
        (equity_series[i] - equity_series[i - 1]) / equity_series[i - 1]
        for i in range(1, len(equity_series))
        if equity_series[i - 1] > 0
    ]
    years = max(0.25, trading_days / 252.0)
    total_mult = equity_series[-1] / equity_series[0]
    cagr = (total_mult ** (1.0 / years) - 1.0) * 100.0 if total_mult > 0 else -100.0

    mean_d = statistics.mean(daily_rets) if daily_rets else 0.0
    std_d = statistics.stdev(daily_rets) if len(daily_rets) > 1 else 0.0
    vol_ann = std_d * math.sqrt(252.0) * 100.0
    rf_daily = 0.015 / 252.0
    sharpe = ((mean_d - rf_daily) / std_d * math.sqrt(252.0)) if std_d > 0 else 0.0

    downside = [min(0.0, r - rf_daily) for r in daily_rets]
    down_dev = math.sqrt(sum(d * d for d in downside) / len(downside)) if downside else 0.0
    sortino = ((mean_d - rf_daily) / down_dev * math.sqrt(252.0)) if down_dev > 0 else 0.0

    peak = equity_series[0]
    mdd = 0.0
    for eq in equity_series:
        if eq > peak:
            peak = eq
        dd = (eq - peak) / peak * 100.0 if peak > 0 else 0.0
        if dd < mdd:
            mdd = dd

    calmar = (cagr / abs(mdd)) if mdd < 0 else 0.0
    return {
        "cagrPct": round(cagr, 2),
        "volPct": round(vol_ann, 2),
        "sharpe": round(sharpe, 2),
        "sortino": round(sortino, 2),
        "calmar": round(calmar, 2),
        "mddPct": round(mdd, 2),
    }


def simulate_period(
    dates: List[str],
    stock_meta: Dict[str, Dict[str, str]],
    stock_bars: Dict[str, List[Dict[str, Any]]],
    stock_date_idx: Dict[str, Dict[str, int]],
    twii_bars: List[Dict[str, Any]],
    twii_idx_map: Dict[str, int],
    initial_capital: float = 100_000.0,
    max_up_streak: int = 2,
    trigger_mode: str = "STRICT",
    max_holdings: int = 4,
    quarters_lookup: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    max_single_pct = 0.16 if max_holdings >= 6 else 0.24
    risk_pct = 0.01

    cash = initial_capital
    gross_cash = initial_capital
    open_pos: Dict[str, Dict[str, Any]] = {}
    gross_pos: Dict[str, Dict[str, Any]] = {}
    today_closes: Dict[str, float] = {}

    eq_series: List[float] = []
    gross_eq_series: List[float] = []
    bm_series: List[float] = []
    equity_curve: List[Dict[str, Any]] = []
    closed_trades: List[Dict[str, Any]] = []
    exposure_samples: List[float] = []
    selected_stocks = set()
    total_costs_paid = 0.0
    stops_count = 0

    # 按季統計容器 (僅當傳入 quarters_lookup 時記錄)
    q_stats: Dict[str, Dict[str, Any]] = {}
    twii_start = twii_bars[twii_idx_map[dates[0]]]["close"]

    for d in dates:
        q_name = quarters_lookup.get(d, "P1") if quarters_lookup else "P1"
        if q_name not in q_stats:
            cur_eq = cash + sum(p["shares"] * today_closes.get(c, p["avgCost"]) for c, p in open_pos.items())
            q_stats[q_name] = {
                "quarter": q_name,
                "startDate": d,
                "endDate": d,
                "startEquity": round(cur_eq),
                "selected": set(),
                "wins": 0,
                "losses": 0,
                "stops": 0,
            }
        q_stats[q_name]["endDate"] = d

        # 大盤定調
        ti = twii_idx_map.get(d)
        mkt_chg, mkt_ret5, mkt_tone = 0.0, 0.0, "震盪整理"
        twii_close = twii_start
        if ti is not None and ti >= 1:
            twii_close = twii_bars[ti]["close"]
            prev_twii = twii_bars[ti - 1]["close"]
            mkt_chg = ((twii_close - prev_twii) / prev_twii) * 100.0 if prev_twii > 0 else 0.0
            prev5 = twii_bars[ti - 5]["close"] if ti >= 5 else prev_twii
            mkt_ret5 = ((twii_close - prev5) / prev5) * 100.0 if prev5 > 0 else mkt_chg
            m_sma5 = twii_bars[ti]["sma5"]
            m_sma20 = twii_bars[ti]["sma20"]
            m_sma60 = twii_bars[ti]["sma60"]
            if twii_close > m_sma5 and twii_close > m_sma20 and m_sma20 > m_sma60:
                mkt_tone = "偏多格局"
            elif twii_close < m_sma20 and mkt_chg <= -1.5:
                mkt_tone = "空頭警戒"

        day_candidates = []

        for code, bars in stock_bars.items():
            idx = stock_date_idx[code].get(d)
            if idx is None or idx < 61:
                continue
            b = bars[idx]
            today_closes[code] = b["close"]

            if code in open_pos:
                pos = open_pos[code]
                gpos = gross_pos[code]
                pos["daysHeld"] += 1
                pnl_pct = ((b["close"] - pos["avgCost"]) / pos["avgCost"]) * 100.0
                sell_shares, sell_reason = 0, ""

                if b["close"] <= pos["stopLoss"] or b["close"] < b["sma20"] * 0.995:
                    sell_shares = pos["shares"]
                    sell_reason = f"硬停損 ({round(b['close'], 2)}<={pos['stopLoss']})"
                    stops_count += 1
                    q_stats[q_name]["stops"] += 1
                elif pnl_pct >= 15 and pos["shares"] >= 3:
                    sell_shares = max(1, pos["shares"] // 3)
                    sell_reason = f"移動停利一 (+{pnl_pct:.1f}%賣1/3)"
                elif b["isHalfBodyDown"] and pos["shares"] >= 2:
                    sell_shares = max(1, pos["shares"] // 2)
                    sell_reason = "移動停利二 (反下半身減碼)"
                elif (
                    pos["daysHeld"] >= 5
                    and abs(pnl_pct) < 2.5
                    and abs(b["sma5"] - bars[idx - 1]["sma5"]) / max(1.0, b["sma5"]) < 0.002
                    and b["macdHist"] < b["prevMacdHist"]
                ):
                    sell_shares = max(1, pos["shares"] // 2)
                    sell_reason = f"時間停損 ({pos['daysHeld']}日橫盤減半)"

                if sell_shares > 0:
                    amount = round(sell_shares * b["close"])
                    fee = calc_bot_fee(amount)
                    tax = calc_bot_tax(code, amount)
                    total_costs_paid += (fee + tax)
                    net_proceeds = amount - fee - tax
                    buy_fee_est = calc_bot_fee(round(sell_shares * pos["avgCost"]))
                    net_pnl = round(net_proceeds - (sell_shares * pos["avgCost"]) - buy_fee_est)
                    trade_pnl_pct = ((net_proceeds - (sell_shares * pos["avgCost"]) - buy_fee_est) / max(1.0, sell_shares * pos["avgCost"])) * 100.0

                    cash += net_proceeds
                    gross_cash += amount
                    pos["shares"] -= sell_shares
                    gpos["shares"] -= sell_shares

                    if net_pnl >= 0:
                        q_stats[q_name]["wins"] += 1
                    else:
                        q_stats[q_name]["losses"] += 1

                    closed_trades.append({
                        "sym": code,
                        "name": pos["name"],
                        "category": stock_meta[code]["category"],
                        "quarter": q_name,
                        "entryDate": pos["entryDate"],
                        "exitDate": d,
                        "holdDays": pos["daysHeld"],
                        "entryPrice": round(pos["avgCost"], 2),
                        "exitPrice": round(b["close"], 2),
                        "shares": sell_shares,
                        "pnlAmount": net_pnl,
                        "pnlPct": round(trade_pnl_pct, 2),
                        "reason": sell_reason,
                    })

                    if pos["shares"] <= 0:
                        del open_pos[code]
                        del gross_pos[code]
                    else:
                        pos["stopLoss"] = max(pos["stopLoss"], pos["avgCost"])
                elif pos["stage"] < 3 and cash >= initial_capital * 0.30:
                    can_add2 = pos["stage"] == 1 and pnl_pct >= 4 and b["close"] > b["sma5"] and b["sma5"] > bars[idx - 1]["sma5"]
                    can_add3 = pos["stage"] == 2 and pnl_pct >= 8 and b["close"] > b["sma5"]
                    if can_add2 or can_add3:
                        exec_px = round_to_tick(b["close"] + get_tick_size(b["close"]))
                        add_shares = int(((initial_capital * max_single_pct) / 3.0) // exec_px)
                        amount = round(add_shares * exec_px)
                        fee = calc_bot_fee(amount)
                        if add_shares >= 1 and (cash - amount - fee) >= initial_capital * 0.30:
                            total_costs_paid += fee
                            cash -= (amount + fee)
                            gross_cash -= amount
                            new_shares = pos["shares"] + add_shares
                            pos["avgCost"] = round(((pos["shares"] * pos["avgCost"]) + amount) / new_shares, 2)
                            pos["shares"] = new_shares
                            gpos["shares"] = new_shares
                            pos["stage"] += 1
                            new_stop = pos["avgCost"] if pos["stage"] == 3 else round_to_tick(pos["avgCost"] * 0.95)
                            pos["stopLoss"] = max(pos["stopLoss"], new_stop)
                continue

            # 評估新進場候選
            c01 = b["changePct"] >= mkt_chg and b["ret5"] >= mkt_ret5
            has_resonance = b["c04"] or b["isHalfBodyUp"] or b["isBirdBeak"] or b["isBullEngulfing"] or b["isMorningStar"]
            has_momentum = (trigger_mode == "RELAXED") and (b["c05"] or b["c06"])
            is_excluded = (b["upStreak"] >= max_up_streak) or b["isHighUpperShadow"]

            if b["c08"] and b["c09"] and c01 and not is_excluded and (has_resonance or has_momentum):
                score = 3
                if b["c04"]:
                    score += 1
                if b["isHalfBodyUp"]:
                    score += 1
                if b["isBirdBeak"]:
                    score += 1
                if b["isBullEngulfing"] or b["isMorningStar"]:
                    score += 1
                if b["c05"]:
                    score += 1
                if b["c06"]:
                    score += 1

                stop_loss = round_to_tick(min(b["close"] * 0.94, max(b["close"] * 0.92, max(b["recentLow10"], b["sma20"] * 0.99))))
                limit_price = round_to_tick(b["close"] + get_tick_size(b["close"]))
                max_by_risk = int((initial_capital * risk_pct) // max(1.0, limit_price - stop_loss))
                max_by_cap = int(((initial_capital * max_single_pct) / 3.0) // limit_price)
                rec_shares = max(0, min(max_by_risk, max_by_cap))
                if rec_shares >= 1:
                    day_candidates.append({
                        "code": code,
                        "name": stock_meta[code]["name"],
                        "score": score,
                        "c02": 1 if stock_meta[code]["c02Status"] == "穩健" else 0,
                        "volume": b["volume"],
                        "recShares": rec_shares,
                        "limitPrice": limit_price,
                        "stopLoss": stop_loss,
                    })

        # 執行新進場
        min_cash_keep = initial_capital * (0.50 if mkt_tone == "空頭警戒" else 0.30)
        held_cnt = len(open_pos)
        if mkt_tone != "空頭警戒" and held_cnt < max_holdings and cash > min_cash_keep:
            day_candidates.sort(key=lambda x: (x["score"], x["c02"], x["volume"]), reverse=True)
            slots = max_holdings - held_cnt
            for cand in day_candidates:
                if slots <= 0:
                    break
                amount = round(cand["recShares"] * cand["limitPrice"])
                fee = calc_bot_fee(amount)
                if (cash - amount - fee) >= min_cash_keep:
                    total_costs_paid += fee
                    cash -= (amount + fee)
                    gross_cash -= amount
                    open_pos[cand["code"]] = {
                        "code": cand["code"],
                        "name": cand["name"],
                        "stage": 1,
                        "shares": cand["recShares"],
                        "avgCost": cand["limitPrice"],
                        "stopLoss": cand["stopLoss"],
                        "entryDate": d,
                        "daysHeld": 0,
                    }
                    gross_pos[cand["code"]] = {"shares": cand["recShares"]}
                    lbl = f"{cand['code']} {cand['name']}"
                    selected_stocks.add(lbl)
                    q_stats[q_name]["selected"].add(lbl)
                    slots -= 1

        mv = sum(round(p["shares"] * today_closes.get(c, p["avgCost"])) for c, p in open_pos.items())
        gmv = sum(round(p["shares"] * today_closes.get(c, open_pos[c]["avgCost"])) for c, p in gross_pos.items())
        day_eq = cash + mv
        day_gross_eq = gross_cash + gmv
        bm_eq = initial_capital * (twii_close / twii_start)

        exposure_samples.append(mv / day_eq if day_eq > 0 else 0.0)
        eq_series.append(day_eq)
        gross_eq_series.append(day_gross_eq)
        bm_series.append(bm_eq)
        equity_curve.append({"date": d, "equity": round(day_eq), "grossEquity": round(day_gross_eq), "benchmark": round(bm_eq)})
        q_stats[q_name]["endEquity"] = round(day_eq)

    # 結算尚持有部位的勝敗計入分段統計
    open_wins = sum(1 for c, p in open_pos.items() if today_closes.get(c, p["avgCost"]) >= p["avgCost"])
    open_losses = len(open_pos) - open_wins

    metrics = compute_risk_metrics(eq_series, len(dates))
    bm_metrics = compute_risk_metrics(bm_series, len(dates))

    quarter_reports = []
    for q_name, qs in q_stats.items():
        tot = qs["wins"] + qs["losses"]
        s_eq = qs["startEquity"]
        e_eq = qs["endEquity"]
        quarter_reports.append({
            "quarter": q_name,
            "period": f"{qs['startDate']} ~ {qs['endDate']}",
            "startEquity": s_eq,
            "endEquity": e_eq,
            "quarterReturnPct": round(((e_eq - s_eq) / s_eq) * 100.0, 2) if s_eq > 0 else 0.0,
            "cumReturnPct": round(((e_eq - initial_capital) / initial_capital) * 100.0, 2),
            "selectedStocks": sorted(list(qs["selected"])),
            "closedCount": tot,
            "winRatePct": round((qs["wins"] / tot) * 100.0, 1) if tot > 0 else 100.0,
            "stopLossCount": qs["stops"],
        })

    return {
        "period": f"{dates[0]} ~ {dates[-1]}",
        "startEquity": int(initial_capital),
        "endEquity": round(eq_series[-1]),
        "grossFinalEquity": round(gross_eq_series[-1]),
        "returnPct": round((eq_series[-1] - initial_capital) / initial_capital * 100.0, 2),
        "grossReturnPct": round((gross_eq_series[-1] - initial_capital) / initial_capital * 100.0, 2),
        "benchmarkPct": round((bm_series[-1] - initial_capital) / initial_capital * 100.0, 2),
        "mddPct": metrics["mddPct"],
        "benchmarkMddPct": bm_metrics["mddPct"],
        "metrics": metrics,
        "benchmarkMetrics": bm_metrics,
        "avgExposurePct": round(statistics.mean(exposure_samples) * 100.0, 1) if exposure_samples else 0.0,
        "totalCostsPaid": round(total_costs_paid),
        "closedTrades": closed_trades,
        "tradesCount": len(closed_trades) + len(open_pos),
        "winRatePct": round(
            ((sum(1 for t in closed_trades if t["pnlAmount"] >= 0) + open_wins) / max(1, len(closed_trades) + len(open_pos))) * 100.0,
            1,
        ) if (closed_trades or open_pos) else 0.0,
        "stopLossCount": stops_count,
        "selectedStocks": sorted(list(selected_stocks)),
        "quarters": quarter_reports,
        "equityCurve": equity_curve,
    }


def summarize_cohorts(cohorts: List[Dict[str, Any]]) -> Dict[str, Any]:
    rets = [c["returnPct"] for c in cohorts]
    bms = [c["benchmarkPct"] for c in cohorts]
    pos_count = sum(1 for r in rets if r > 0)
    beat_bm = sum(1 for c in cohorts if c["returnPct"] > c["benchmarkPct"])
    return {
        "totalPeriods": len(cohorts),
        "positivePeriods": pos_count,
        "positiveRatePct": round(pos_count / len(cohorts) * 100.0, 1) if cohorts else 0.0,
        "beatBenchmarkCount": beat_bm,
        "avgReturnPct": round(statistics.mean(rets), 2) if rets else 0.0,
        "medianReturnPct": round(statistics.median(rets), 2) if rets else 0.0,
        "avgBenchmarkPct": round(statistics.mean(bms), 2) if bms else 0.0,
        "bestReturnPct": max(rets) if rets else 0.0,
        "worstReturnPct": min(rets) if rets else 0.0,
        "avgMddPct": round(statistics.mean([c["mddPct"] for c in cohorts]), 2) if cohorts else 0.0,
    }


def run_backtest(gas_url: Optional[str] = None, pin: Optional[str] = None, max_up_streak: int = 2, trigger_mode: str = "STRICT", max_holdings: int = 4) -> Dict[str, Any]:
    watchlist = load_watchlist(gas_url, pin)
    stock_meta = {w["code"]: w for w in watchlist}

    print(f"[INFO] Fetching 6y adjusted historical bars for {len(watchlist)} TW stocks + ^TWII...")
    stock_bars: Dict[str, List[Dict[str, Any]]] = {}
    stock_date_idx: Dict[str, Dict[str, int]] = {}
    all_dates_set = set()

    def _fetch_one(item: Dict[str, str]) -> Tuple[str, List[Dict[str, Any]]]:
        suffix = ".TWO" if item["market"] == "TPEX" else ".TW"
        try:
            bars = fetch_yahoo_history(f"{item['code']}{suffix}")
            return item["code"], bars
        except Exception:
            return item["code"], []

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        for code, bars in executor.map(_fetch_one, watchlist):
            if len(bars) >= 70:
                precompute_indicators(bars)
                stock_bars[code] = bars
                stock_date_idx[code] = {b["date"]: idx for idx, b in enumerate(bars)}
                for b in bars:
                    all_dates_set.add(b["date"])

    twii_bars = fetch_yahoo_history("^TWII")
    precompute_indicators(twii_bars)
    twii_idx_map = {b["date"]: idx for idx, b in enumerate(twii_bars)}

    end_dt = datetime.strptime(max(all_dates_set), "%Y-%m-%d")
    start_dt = end_dt - timedelta(days=365 * 5 + 1)
    sim_dates = sorted([d for d in all_dates_set if d >= start_dt.strftime("%Y-%m-%d") and d in twii_idx_map])

    quarters_lookup: Dict[str, str] = {}
    quarter_date_lists: List[Tuple[str, List[str]]] = []
    q_start = start_dt
    for q_idx in range(1, 21):
        q_end = q_start + timedelta(days=91) if q_idx < 20 else end_dt + timedelta(days=1)
        q_dates = [d for d in sim_dates if q_start.strftime("%Y-%m-%d") <= d < q_end.strftime("%Y-%m-%d")]
        if q_dates:
            q_label = f"Q{q_idx}"
            quarter_date_lists.append((q_label, q_dates))
            for d in q_dates:
                quarters_lookup[d] = q_label
        q_start = q_end

    init_cap = 100_000.0
    full_res = simulate_period(
        sim_dates, stock_meta, stock_bars, stock_date_idx, twii_bars, twii_idx_map,
        initial_capital=init_cap, max_up_streak=max_up_streak, trigger_mode=trigger_mode,
        max_holdings=max_holdings, quarters_lookup=quarters_lookup,
    )

    eq_curve = full_res["equityCurve"]
    eq_series = [p["equity"] for p in eq_curve]
    bm_series = [p["benchmark"] for p in eq_curve]
    split_idx = next((i for i, p in enumerate(eq_curve) if p["date"] >= "2025-01-01"), len(eq_curve) // 2)
    is_eq, oos_eq = eq_series[:split_idx], eq_series[split_idx:]
    is_bm, oos_bm = bm_series[:split_idx], bm_series[split_idx:]

    in_sample = {
        "period": f"{eq_curve[0]['date']} ~ {eq_curve[split_idx - 1]['date']}",
        "strategyReturnPct": round((is_eq[-1] - is_eq[0]) / is_eq[0] * 100.0, 2),
        "benchmarkReturnPct": round((is_bm[-1] - is_bm[0]) / is_bm[0] * 100.0, 2),
        **compute_risk_metrics(is_eq, len(is_eq)),
    }
    out_sample = {
        "period": f"{eq_curve[split_idx]['date']} ~ {eq_curve[-1]['date']}",
        "strategyReturnPct": round((oos_eq[-1] - oos_eq[0]) / oos_eq[0] * 100.0, 2),
        "benchmarkReturnPct": round((oos_bm[-1] - oos_bm[0]) / oos_bm[0] * 100.0, 2),
        **compute_risk_metrics(oos_eq, len(oos_eq)),
    }

    # 分段回滾：每 3 個月獨立起點 (20 期) & 每 6 個月獨立起點 (10 期)
    ind_3m = []
    for idx, (_, q_dates) in enumerate(quarter_date_lists, 1):
        r = simulate_period(
            q_dates, stock_meta, stock_bars, stock_date_idx, twii_bars, twii_idx_map,
            initial_capital=init_cap, max_up_streak=max_up_streak, trigger_mode=trigger_mode, max_holdings=max_holdings,
        )
        ind_3m.append({
            "label": f"3M-{idx:02d}",
            "period": r["period"],
            "startEquity": r["startEquity"],
            "endEquity": r["endEquity"],
            "returnPct": r["returnPct"],
            "benchmarkPct": r["benchmarkPct"],
            "mddPct": r["mddPct"],
            "winRatePct": r["winRatePct"],
            "tradesCount": r["tradesCount"],
            "stopLossCount": r["stopLossCount"],
            "selectedStocks": r["selectedStocks"],
        })

    ind_6m = []
    h_start = start_dt
    for h_idx in range(1, 11):
        h_end = h_start + timedelta(days=182) if h_idx < 10 else end_dt + timedelta(days=1)
        h_dates = [d for d in sim_dates if h_start.strftime("%Y-%m-%d") <= d < h_end.strftime("%Y-%m-%d")]
        if h_dates:
            r = simulate_period(
                h_dates, stock_meta, stock_bars, stock_date_idx, twii_bars, twii_idx_map,
                initial_capital=init_cap, max_up_streak=max_up_streak, trigger_mode=trigger_mode, max_holdings=max_holdings,
            )
            ind_6m.append({
                "label": f"6M-{h_idx:02d}",
                "period": r["period"],
                "startEquity": r["startEquity"],
                "endEquity": r["endEquity"],
                "returnPct": r["returnPct"],
                "benchmarkPct": r["benchmarkPct"],
                "mddPct": r["mddPct"],
                "winRatePct": r["winRatePct"],
                "tradesCount": r["tradesCount"],
                "stopLossCount": r["stopLossCount"],
                "selectedStocks": r["selectedStocks"],
            })
        h_start = h_end

    closed_trades = full_res["closedTrades"]
    overall_wins = sum(1 for t in closed_trades if t["pnlAmount"] >= 0)

    result = {
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "universeCount": len(stock_bars),
        "methodology": "adjclose 還原除權息｜C01/C08/C09+共振買點+三批加碼｜6折手續費(低消1元)+證交稅",
        "window": full_res["period"],
        "initialCapital": int(init_cap),
        "finalEquity": full_res["endEquity"],
        "grossFinalEquity": full_res["grossFinalEquity"],
        "totalReturnPct": full_res["returnPct"],
        "grossReturnPct": full_res["grossReturnPct"],
        "totalCostsPaid": full_res["totalCostsPaid"],
        "benchmarkReturnPct": full_res["benchmarkPct"],
        "maxDrawdownPct": full_res["mddPct"],
        "benchmarkMddPct": full_res["benchmarkMddPct"],
        "avgExposurePct": full_res["avgExposurePct"],
        "metrics": full_res["metrics"],
        "benchmarkMetrics": full_res["benchmarkMetrics"],
        "inSample": in_sample,
        "outSample": out_sample,
        "totalClosedTrades": len(closed_trades),
        "overallWinRatePct": round((overall_wins / len(closed_trades)) * 100.0, 1) if closed_trades else 0.0,
        "quarters": full_res["quarters"],
        "closedTrades": closed_trades[-120:],
        "equityCurve": eq_curve[::5] + ([eq_curve[-1]] if len(eq_curve) % 5 != 1 else []),
        "independent3M": {"summary": summarize_cohorts(ind_3m), "cohorts": ind_3m},
        "independent6M": {"summary": summarize_cohorts(ind_6m), "cohorts": ind_6m},
    }

    os.makedirs("data", exist_ok=True)
    out_path = os.path.join("data", "backtest_5y.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(
        f"[DONE] Stocks: {len(stock_bars)} | Net: {result['totalReturnPct']}% "
        f"(BM: {result['benchmarkReturnPct']}%) | Sharpe: {result['metrics']['sharpe']} | MDD: {result['maxDrawdownPct']}%"
    )
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="盤後零股 5 年歷史回測與分段滾動實測")
    parser.add_argument("--gas-url", default=os.environ.get("GAS_URL"), help="GAS Web App URL (選填)")
    parser.add_argument("--pin", default=os.environ.get("GAS_PIN"), help="GAS PIN (選填)")
    parser.add_argument("--max-streak", type=int, default=2, help="連漲排除門檻 (預設 2)")
    parser.add_argument("--trigger-mode", default="STRICT", choices=["STRICT", "RELAXED"], help="買點觸發模式")
    parser.add_argument("--max-holdings", type=int, default=4, help="同時持股上限 (4 或 6)")
    args = parser.parse_args()
    run_backtest(args.gas_url, args.pin, args.max_streak, args.trigger_mode, args.max_holdings)
