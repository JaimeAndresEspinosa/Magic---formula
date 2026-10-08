"""Magic Formula Screener — backend.

Fundamentales (EBIT, balance) se descargan de Yahoo Finance con yfinance y se
cachean en disco (se renuevan cada 24 h). Los precios se refrescan en segundo
plano cada 30 s con mercado abierto, y el Earnings Yield se recalcula con el
precio en vivo en cada petición.
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import storage
from universes import META, load_universes

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("magic")
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

BASE = Path(__file__).parent
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)
FUND_FILE = DATA / "fundamentals.json"


FUND_MAX_AGE = float(os.getenv("FUND_MAX_AGE_H", "24")) * 3600
PRICE_EVERY_OPEN = 30
PRICE_EVERY_CLOSED = 300
WORKERS = 3
MIN_GAP = 1.5  # s entre peticiones de fundamentales (límite de Yahoo)
# Índice de referencia de cada universo (para la cartera simulada)
BENCHMARKS = {"sp500": "^GSPC", "ndx": "^NDX", "ibex": "^IBEX", "sx5e": "^STOXX50E"}
SCHEMA = 2  # subir para forzar la redescarga de fundamentales
EXCLUDED_SECTORS = {"Financial Services", "Utilities", "Real Estate"}

SECTOR_ES = {
    "Technology": "Tecnología", "Healthcare": "Salud", "Consumer Cyclical": "Consumo cíclico",
    "Consumer Defensive": "Consumo defensivo", "Industrials": "Industria",
    "Communication Services": "Comunicaciones", "Energy": "Energía",
    "Basic Materials": "Materiales", "Real Estate": "Inmobiliario",
    "Financial Services": "Financiero", "Utilities": "Utilities",
}


# --------------------------------------------------------------------------- estado
class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.universes: dict[str, list[str]] = {}
        self.fund: dict[str, dict] = {}
        self.prices: dict[str, dict] = {}
        self.usd_per: dict[str, float] = {"USD": 1.0}
        self.last_price_update: float | None = None
        self.fund_progress = {"done": 0, "total": 0, "running": False}
        self.history_cache: dict[tuple, tuple[float, list]] = {}
        self.snapshot = {"last_date": None, "state": "idle", "msg": None}
        self.snapshot_lock = threading.Lock()
        if FUND_FILE.exists():
            try:
                self.fund = json.loads(FUND_FILE.read_text())
                log.info("Loaded %d cached fundamentals", len(self.fund))
            except Exception:  # noqa: BLE001
                log.warning("Corrupt fundamentals cache, starting fresh")

    def save_fund(self):
        with self.lock:
            tmp = FUND_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.fund))
            tmp.replace(FUND_FILE)

    def all_symbols(self) -> list[str]:
        seen, out = set(), []
        for key in ("ibex", "sx5e", "ndx", "sp500"):
            for s in self.universes.get(key, []):
                if s not in seen:
                    seen.add(s)
                    out.append(s)
        return out


S = Store()


# --------------------------------------------------------------------------- fundamentales
def _num(x) -> float | None:
    try:
        v = float(x)
        return None if math.isnan(v) or math.isinf(v) else v
    except (TypeError, ValueError):
        return None


def _bs_value(bs: pd.DataFrame, names: list[str]) -> float | None:
    """Primer valor disponible del balance más reciente (si falta, el anterior)."""
    if bs is None or bs.empty:
        return None
    for name in names:
        if name in bs.index:
            for col in bs.columns[:2]:
                v = _num(bs.at[name, col])
                if v is not None:
                    return v
    return None


def goodwill_intangibles(bs: pd.DataFrame) -> float | None:
    """Fondo de comercio + otros intangibles. 0 si el balance no los tiene;
    None si no hay balance."""
    if bs is None or bs.empty:
        return None
    total = _bs_value(bs, ["Goodwill And Other Intangible Assets"])
    if total is None:
        gw = _bs_value(bs, ["Goodwill"])
        oth = _bs_value(bs, ["Other Intangible Assets"])
        total = (gw or 0.0) + (oth or 0.0)
    return total


def _ttm_ebit(q: pd.DataFrame, a: pd.DataFrame) -> tuple[float | None, str, str | None]:
    for name in ("EBIT", "Operating Income"):
        if q is not None and not q.empty and name in q.index:
            vals = [_num(v) for v in q.loc[name].iloc[:4]]
            cols = list(q.columns[:4])
            if len(vals) == 4 and all(v is not None for v in vals):
                span_days = (cols[0] - cols[3]).days
                if 250 <= span_days <= 300:
                    return sum(vals), "TTM (4 trimestres)", cols[0].strftime("%Y-%m-%d")
    for name in ("EBIT", "Operating Income"):
        if a is not None and not a.empty and name in a.index:
            v = _num(a.loc[name].iloc[0])
            if v is not None:
                return v, f"Anual FY{a.columns[0].year}", a.columns[0].strftime("%Y-%m-%d")
    return None, "—", None


FWD_MIN, FWD_MAX = -0.5, 1.0   # límites del crecimiento esperado (evita cifras absurdas)


def estimaciones(t) -> dict:
    """Consenso de beneficio por acción de este ejercicio y del siguiente (mismo criterio
    ajustado de los analistas). Crecimiento esperado = BPA año siguiente / BPA este año - 1."""
    vacio = {"eps_0y": None, "eps_1y": None, "n_analistas": None, "crec_fwd": None}
    try:
        e = t.earnings_estimate
    except Exception:  # noqa: BLE001
        return vacio
    if e is None or e.empty or "0y" not in e.index or "+1y" not in e.index:
        return vacio
    e0, e1 = _num(e.at["0y", "avg"]), _num(e.at["+1y", "avg"])
    n = _num(e.at["+1y", "numberOfAnalysts"]) if "numberOfAnalysts" in e.columns else None
    crec = None
    if e0 and e1 and e0 > 0:
        crec = min(max(e1 / e0 - 1, FWD_MIN), FWD_MAX)
    return {"eps_0y": e0, "eps_1y": e1, "n_analistas": n, "crec_fwd": crec}


def fetch_fundamentals(sym: str) -> dict:
    t = yf.Ticker(sym)
    info = t.info or {}
    # Con rate limit Yahoo a veces devuelve info vacío sin error: reintentar
    if not (info.get("shortName") or info.get("longName")):
        raise RuntimeError("Rate limited: empty info")
    q_is, a_is = t.quarterly_income_stmt, t.income_stmt
    q_bs = t.quarterly_balance_sheet
    bs = q_bs if q_bs is not None and not q_bs.empty else t.balance_sheet

    ebit, ebit_src, period = _ttm_ebit(q_is, a_is)

    # Acciones: implícitas en la capitalización de Yahoo (incluye todas las clases,
    # p. ej. Puig A+B); si no, las acciones en circulación declaradas.
    px = _num(info.get("regularMarketPrice") or info.get("previousClose"))
    mc = _num(info.get("marketCap"))
    shares = (_num(info.get("impliedSharesOutstanding"))
              or (mc / px if mc and px else None)
              or _num(info.get("sharesOutstanding"))
              or _bs_value(bs, ["Ordinary Shares Number", "Share Issued"]))

    # Deuda: fila agregada; si falta, suma de largo + corto plazo; si no, el dato de Yahoo.
    debt = _bs_value(bs, ["Total Debt"])
    debt_src = "balance"
    if debt is None:
        lt = _bs_value(bs, ["Long Term Debt And Capital Lease Obligation", "Long Term Debt"])
        st = _bs_value(bs, ["Current Debt And Capital Lease Obligation", "Current Debt"])
        debt = (lt or 0) + (st or 0) if lt is not None or st is not None else None
        debt_src = "largo + corto plazo"
    if debt is None:
        debt, debt_src = _num(info.get("totalDebt")), "Yahoo totalDebt"

    short, long_ = info.get("shortName"), info.get("longName")
    name = long_ if long_ and (not short or short.isupper()) else short or long_ or sym
    return {
        "v": SCHEMA,
        "symbol": sym,
        "name": name,
        "long_name": info.get("longName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "country": info.get("country"),
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "website": info.get("website"),
        "summary": (info.get("longBusinessSummary") or "")[:900],
        "currency": info.get("currency") or "USD",
        "fin_currency": info.get("financialCurrency") or info.get("currency") or "USD",
        "shares": shares,
        "ebit": ebit,
        "ebit_source": ebit_src,
        "period": period,
        "current_assets": _bs_value(bs, ["Current Assets"]),
        "current_liabilities": _bs_value(bs, ["Current Liabilities"]),
        "cash": _bs_value(bs, ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"]) or 0.0,
        "current_debt": _bs_value(bs, ["Current Debt And Capital Lease Obligation", "Current Debt"]) or 0.0,
        "net_ppe": _bs_value(bs, ["Net PPE"]) or 0.0,
        "goodwill": goodwill_intangibles(bs),
        **estimaciones(t),
        "total_debt": debt or 0.0,
        "debt_missing": debt is None,
        "debt_source": debt_src if debt is not None else "no disponible",
        "minority": _bs_value(bs, ["Minority Interest"]) or 0.0,
        "preferred": _bs_value(bs, ["Preferred Stock"]) or 0.0,
        "fallback_price": _num(info.get("regularMarketPrice") or info.get("previousClose")),
        "fetched_at": time.time(),
    }


_throttle_lock = threading.Lock()
_next_slot = 0.0
_backoff_until = 0.0


def _throttle():
    """Espaciado global entre peticiones y pausa compartida si Yahoo limita."""
    global _next_slot
    with _throttle_lock:
        now = time.time()
        slot = max(now, _next_slot, _backoff_until)
        _next_slot = slot + MIN_GAP
    time.sleep(max(0.0, slot - now))


def _is_rate_limit(e: Exception) -> bool:
    msg = str(e)
    return "Rate" in msg or "Too Many" in msg or "429" in msg


def _fetch_with_retry(sym: str) -> dict | None:
    global _backoff_until
    for attempt in range(4):
        _throttle()
        try:
            return fetch_fundamentals(sym)
        except Exception as e:  # noqa: BLE001
            if _is_rate_limit(e):
                wait = 45 * (attempt + 1)
                _backoff_until = max(_backoff_until, time.time() + wait)
                log.warning("Rate limited on %s, pausing all fundamentals %ss", sym, wait)
            else:
                log.warning("Fundamentals %s failed (%s)", sym, str(e)[:80])
                time.sleep(2)
    return None


def fundamentals_loop():
    while True:
        failed = 0
        try:
            S.universes = load_universes()
            syms = S.all_symbols()
            now = time.time()
            todo = [s for s in syms
                    if S.fund.get(s, {}).get("v") != SCHEMA
                    or now - S.fund.get(s, {}).get("fetched_at", 0) > FUND_MAX_AGE]
            S.fund_progress = {"done": len(syms) - len(todo), "total": len(syms), "running": bool(todo)}
            if todo:
                log.info("Fetching fundamentals for %d tickers", len(todo))
                with ThreadPoolExecutor(WORKERS) as ex:
                    futs = {ex.submit(_fetch_with_retry, s): s for s in todo}
                    for i, fut in enumerate(as_completed(futs), 1):
                        res = fut.result()
                        if res:
                            with S.lock:
                                S.fund[futs[fut]] = res
                        else:
                            failed += 1
                        S.fund_progress["done"] += 1
                        if i % 25 == 0:
                            S.save_fund()
                S.save_fund()
                S.fund_progress["running"] = False
                log.info("Fundamentals done (%d failed)", failed)
        except Exception:  # noqa: BLE001
            log.exception("fundamentals_loop error")
            failed = 1
        time.sleep(300 if failed else 3600)


# --------------------------------------------------------------------------- precios
def market_open() -> dict[str, bool]:
    def is_open(tz, start, end):
        now = datetime.now(ZoneInfo(tz))
        return now.weekday() < 5 and start <= now.time() <= end

    return {
        "us": is_open("America/New_York", dtime(9, 30), dtime(16, 0)),
        "eu": is_open("Europe/Madrid", dtime(9, 0), dtime(17, 35)),
    }


def _fx_symbols() -> list[str]:
    curs = set()
    with S.lock:
        for f in S.fund.values():
            curs.add(f.get("currency"))
            curs.add(f.get("fin_currency"))
    return [f"{c}USD=X" for c in curs if c and c != "USD"]


def _coverage(df) -> int:
    """Número de tickers con algún cierre válido en la descarga."""
    if df is None or df.empty:
        return 0
    try:
        return int(df.xs("Close", axis=1, level=1).notna().any().sum())
    except (KeyError, ValueError):
        return int(df["Close"].notna().any()) if "Close" in df else 0


def refresh_prices():
    syms = S.all_symbols()
    fx = _fx_symbols()
    allsyms = syms + list(BENCHMARKS.values()) + fx
    t0 = time.time()
    for i in range(0, len(allsyms), 200):
        chunk = allsyms[i:i + 200]
        df = None
        for attempt in range(3):
            df = yf.download(chunk, period="5d", interval="1d", group_by="ticker",
                             progress=False, auto_adjust=False, threads=True)
            if _coverage(df) >= 0.9 * len(chunk):
                break
            log.warning("Price chunk %d incomplete (%d/%d), retrying", i, _coverage(df), len(chunk))
            time.sleep(10 * (attempt + 1))
        if df is None or df.empty:
            continue
        for sym in chunk:
            try:
                closes = df[sym]["Close"].dropna() if len(chunk) > 1 else df["Close"].dropna()
            except KeyError:
                continue
            if closes.empty:
                continue
            price = float(closes.iloc[-1])
            prev = float(closes.iloc[-2]) if len(closes) > 1 else None
            if sym.endswith("USD=X"):
                S.usd_per[sym[:3]] = price
            else:
                with S.lock:
                    old = S.prices.get(sym, {}).get("price")
                    S.prices[sym] = {"price": price, "prev": prev, "ts": time.time(),
                                     "bar": closes.index[-1].strftime("%Y-%m-%d"),
                                     "tick": 0 if old is None else (price > old) - (price < old)}
    S.last_price_update = time.time()
    log.info("Prices refreshed: %d symbols in %.1fs", len(allsyms), time.time() - t0)


def price_loop():
    while True:
        try:
            if S.universes:
                refresh_prices()
                maybe_snapshot()
        except Exception:  # noqa: BLE001
            log.exception("price_loop error")
        mo = market_open()
        time.sleep(PRICE_EVERY_OPEN if any(mo.values()) else PRICE_EVERY_CLOSED)


# --------------------------------------------------------------------------- cálculo
def compute(sym: str) -> dict | None:
    f = S.fund.get(sym)
    if not f:
        return None
    p = S.prices.get(sym, {})
    price = p.get("price") or f.get("fallback_price")
    cur, fin = f["currency"], f["fin_currency"]
    usd_cur, usd_fin = S.usd_per.get(cur), S.usd_per.get(fin)
    conv = usd_cur / usd_fin if usd_cur and usd_fin else (1.0 if cur == fin else None)

    shares, ebit = f.get("shares"), f.get("ebit")
    mcap = price * shares if price and shares else None
    mcap_fin = mcap * conv if mcap and conv else None
    ev = (mcap_fin + f["total_debt"] + f["minority"] + f["preferred"] - f["cash"]) if mcap_fin else None

    ca, cl = f.get("current_assets"), f.get("current_liabilities")
    nwc = None
    if ca is not None and cl is not None:
        nwc = (ca - f["cash"]) - (cl - f["current_debt"])
    capital = (max(nwc, 0.0) if nwc is not None else 0.0) + (f.get("net_ppe") or 0.0)

    ey = ebit / ev if ebit is not None and ev and ev > 0 else None
    roc = ebit / capital if ebit is not None and capital > 0 else None
    # Variante: el capital incluye el fondo de comercio e intangibles pagados en adquisiciones
    gw = f.get("goodwill")
    capital_gw = capital + gw if gw is not None else None
    roc_gw = ebit / capital_gw if ebit is not None and capital_gw and capital_gw > 0 else None
    # Variante forward: EBIT de 12 meses ajustado por el crecimiento que esperan los analistas
    crec = f.get("crec_fwd")
    ebit_fwd = ebit * (1 + crec) if ebit is not None and crec is not None else None
    ey_fwd = ebit_fwd / ev if ebit_fwd is not None and ev and ev > 0 else None
    roc_fwd = ebit_fwd / capital if ebit_fwd is not None and capital > 0 else None
    roc_gw_fwd = ebit_fwd / capital_gw if ebit_fwd is not None and capital_gw and capital_gw > 0 else None

    reason = None
    if f.get("sector") in EXCLUDED_SECTORS:
        reason = "Sector excluido (financiero, utilities o inmobiliario)"
    elif not f.get("sector"):
        reason = "Sector no disponible"
    elif ebit is None or mcap is None or f.get("debt_missing"):
        reason = "Datos insuficientes"
    elif ebit <= 0:
        reason = "EBIT negativo"
    elif ey is None:
        reason = "EV ≤ 0"
    elif roc is None:
        reason = "Capital invertido ≤ 0"

    prev = p.get("prev")
    return {
        "symbol": sym, "name": f["name"], "sector": f.get("sector"),
        "sector_es": SECTOR_ES.get(f.get("sector"), f.get("sector") or "Sin clasificar"),
        "industry": f.get("industry"), "country": f.get("country"),
        "currency": cur, "fin_currency": fin,
        "price": price, "prev": prev, "tick": p.get("tick", 0), "price_ts": p.get("ts"),
        "change_pct": (price / prev - 1) if price and prev else None,
        "mcap": mcap, "mcap_usd": mcap * usd_cur if mcap and usd_cur else None,
        "ev": ev, "ebit": ebit, "ebit_source": f.get("ebit_source"), "period": f.get("period"),
        "nwc": nwc, "net_ppe": f.get("net_ppe"), "capital": capital,
        "cash": f["cash"], "total_debt": f["total_debt"], "minority": f["minority"],
        "preferred": f["preferred"], "debt_source": f.get("debt_source"), "current_assets": ca, "current_liabilities": cl,
        "current_debt": f["current_debt"], "shares": shares,
        "goodwill": gw, "capital_gw": capital_gw, "roc_gw": roc_gw,
        "crec_fwd": crec, "n_analistas": f.get("n_analistas"), "eps_0y": f.get("eps_0y"),
        "eps_1y": f.get("eps_1y"), "ebit_fwd": ebit_fwd, "ey_fwd": ey_fwd,
        "roc_fwd": roc_fwd, "roc_gw_fwd": roc_gw_fwd,
        "ey": ey, "roc": roc, "eligible": reason is None, "reason": reason,
    }


# --------------------------------------------------------------------------- ranking diario
SNAPSHOT_MIN_CAP = 5e9   # mismo valor por defecto que la web
SNAPSHOT_TOP = 50
ROC_METHODS = ("tangible", "gw")
NY = ZoneInfo("America/New_York")


def rank_universe(universe: str, method: str, min_cap: float = SNAPSHOT_MIN_CAP) -> list[dict]:
    """Mismo cálculo que hace la web (app.js → rank)."""
    rows = []
    for sym in S.universes.get(universe, []):
        r = compute(sym)
        if not r or not r["eligible"] or (r["mcap_usd"] or 0) < min_cap:
            continue
        rocx = r["roc_gw"] if method == "gw" else r["roc"]
        if rocx is None:
            continue
        rows.append({**r, "rocx": rocx})
    for i, r in enumerate(sorted(rows, key=lambda r: -r["ey"]), 1):
        r["r_ey"] = i
    for i, r in enumerate(sorted(rows, key=lambda r: -r["rocx"]), 1):
        r["r_roc"] = i
    rows.sort(key=lambda r: (r["r_ey"] + r["r_roc"], -r["ey"]))
    for i, r in enumerate(rows, 1):
        r["mf"] = i
    return rows


def snapshot_due() -> str | None:
    """Fecha (Nueva York) a guardar si ya cerró Wall Street y hay precios de cierre."""
    now = datetime.now(NY)
    if now.weekday() >= 5 or now.time() < dtime(16, 20):
        return None
    date = now.date().isoformat()
    if S.snapshot["last_date"] == date or not S.last_price_update:
        return None
    if datetime.fromtimestamp(S.last_price_update, NY) < now.replace(hour=16, minute=5, second=0):
        return None  # todavía no hay un refresco posterior al cierre
    return date


def maybe_snapshot() -> None:
    date = snapshot_due()
    if not date or not S.snapshot_lock.acquire(blocking=False):
        return
    try:
        S.snapshot["state"] = "running"
        records, empty = [], []
        for universe in META:
            bsym = BENCHMARKS[universe]
            for method in ROC_METHODS:
                if storage.exists(date, universe, method):
                    continue
                with S.lock:
                    ranked = rank_universe(universe, method)[:SNAPSHOT_TOP]
                if not ranked:  # p. ej. falta el tipo de cambio: se reintenta luego
                    empty.append(f"{universe}/{method}")
                    continue
                records.append({
                    "date": date, "universe": universe, "roc_method": method,
                    "min_cap": SNAPSHOT_MIN_CAP,
                    "bench": {"s": bsym, "px": S.prices.get(bsym, {}).get("price")},
                    "rows": [{"s": r["symbol"], "n": r["name"], "px": r["price"], "cur": r["currency"],
                              "ey": round(r["ey"], 6), "roc": round(r["rocx"], 6), "mf": r["mf"]}
                             for r in ranked],
                })
        storage.save(records)
        if empty:
            S.snapshot.update(state="partial", msg=f"{len(records)} guardados; pendientes: {', '.join(empty)}")
            log.warning("Snapshot %s incomplete, will retry: %s", date, empty)
            return
        S.snapshot.update(last_date=date, state="done", msg=f"{len(records)} rankings guardados")
        log.info("Snapshot %s: %d records (%s)", date, len(records),
                 "Supabase" if storage.remote_enabled() else "local")
    except Exception as e:  # noqa: BLE001
        S.snapshot.update(state="error", msg=str(e)[:200])
        log.exception("Snapshot failed")
    finally:
        S.snapshot_lock.release()


# --------------------------------------------------------------------------- API
app = FastAPI(title="Magic Formula Screener")


@app.on_event("startup")
def _startup():
    def boot():
        try:
            S.universes = load_universes()
        except Exception:  # noqa: BLE001
            log.exception("Could not load universes at boot")
        threading.Thread(target=price_loop, daemon=True).start()
        fundamentals_loop()

    threading.Thread(target=boot, daemon=True).start()


@app.get("/api/status")
def status():
    return {
        "universes": {k: {**META[k], "count": len(v),
                          "loaded": sum(1 for s in v if s in S.fund)}
                      for k, v in S.universes.items()},
        "fundamentals": S.fund_progress,
        "last_price_update": S.last_price_update,
        "market_open": market_open(),
        "server_time": time.time(),
    }


@app.get("/api/ranking/{universe}")
def ranking(universe: str):
    if universe not in META:
        raise HTTPException(404, "Universo desconocido")
    syms = S.universes.get(universe, [])
    with S.lock:
        rows = [r for r in (compute(s) for s in syms) if r]
    bsym = BENCHMARKS[universe]
    bench = {"symbol": bsym, **{k: S.prices.get(bsym, {}).get(k) for k in ("price", "prev", "ts")}}
    return {"universe": universe, **META[universe], "total": len(syms), "rows": rows, "benchmark": bench,
            "last_price_update": S.last_price_update, "market_open": market_open()}


@app.get("/api/stock/{sym}")
def stock(sym: str):
    with S.lock:
        row = compute(sym)
        f = S.fund.get(sym)
    if not row:
        raise HTTPException(404, "Ticker sin datos")
    return {**row, "long_name": f.get("long_name"), "exchange": f.get("exchange"),
            "website": f.get("website"), "summary": f.get("summary")}


RANGES = {"1m": ("1mo", "1d"), "6m": ("6mo", "1d"), "1y": ("1y", "1d"),
          "5y": ("5y", "1wk"), "1d": ("1d", "5m"), "5d": ("5d", "30m")}


@app.get("/api/history/{sym}")
def history(sym: str, range: str = "1y"):  # noqa: A002
    if range not in RANGES:
        raise HTTPException(400, "Rango no válido")
    key = (sym, range)
    ttl = 60 if range in ("1d", "5d") else 900
    cached = S.history_cache.get(key)
    if cached and time.time() - cached[0] < ttl:
        return cached[1]
    period, interval = RANGES[range]
    h = yf.Ticker(sym).history(period=period, interval=interval, auto_adjust=False)
    pts = [{"t": int(ts.timestamp()), "c": round(float(c), 4)}
           for ts, c in h["Close"].dropna().items()] if not h.empty else []
    S.history_cache[key] = (time.time(), pts)
    return pts


@app.get("/api/config")
def config():
    """Datos públicos para el inicio de sesión (la clave anon/publishable es pública)."""
    enabled = bool(storage.SUPABASE_URL and storage.SUPABASE_ANON_KEY)
    return {"auth": enabled,
            "supabaseUrl": storage.SUPABASE_URL if enabled else None,
            "supabaseAnonKey": storage.SUPABASE_ANON_KEY if enabled else None}


@app.get("/api/cron/snapshot")
def cron_snapshot():
    """Lo llama la tarea diaria de GitHub Actions: despierta el servidor y guarda el
    ranking del día si ya cerró Wall Street. Es idempotente."""
    threading.Thread(target=maybe_snapshot, daemon=True).start()
    return {**S.snapshot, "due": snapshot_due(), "last_price_update": S.last_price_update,
            "storage": "supabase" if storage.remote_enabled() else "local"}


@app.get("/api/snapshots")
def snapshots(universe: str, method: str = "tangible", since: str = "2000-01-01"):
    if universe not in META or method not in ROC_METHODS:
        raise HTTPException(400, "Parámetros no válidos")
    try:
        datetime.strptime(since, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Fecha no válida") from None
    key = ("snap", universe, method, since)
    cached = S.history_cache.get(key)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    data = storage.load(universe, method, since)
    S.history_cache[key] = (time.time(), data)
    return data


@app.get("/api/sim-history")
def sim_history(symbols: str, start: str):
    """Cierres diarios desde `start` para una cartera simulada (precio, sin dividendos)."""
    syms = sorted({s.strip() for s in symbols.split(",") if s.strip()})
    if not syms or len(syms) > 150:
        raise HTTPException(400, "Entre 1 y 150 símbolos")
    try:
        datetime.strptime(start, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Fecha no válida") from None
    key = ("sim", ",".join(syms), start)
    cached = S.history_cache.get(key)
    if cached and time.time() - cached[0] < 1800:
        return cached[1]
    df = yf.download(syms, start=start, interval="1d", group_by="ticker",
                     progress=False, auto_adjust=False, threads=True)
    out = {"dates": [], "closes": {}}
    if df is not None and not df.empty:
        closes = df.xs("Close", axis=1, level=1) if isinstance(df.columns, pd.MultiIndex) else df[["Close"]].set_axis(syms, axis=1)
        closes = closes.ffill()
        out["dates"] = [d.strftime("%Y-%m-%d") for d in closes.index]
        out["closes"] = {s: [None if pd.isna(v) else round(float(v), 4) for v in closes[s]]
                         for s in closes.columns}
    S.history_cache[key] = (time.time(), out)
    return out


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
