"""Universos de inversión. S&P 500 y Nasdaq-100 se descargan de Wikipedia (con
caché en disco); IBEX 35 y Euro Stoxx 50 son listas fijas con sufijos de Yahoo."""
import json
import logging
import time
from io import StringIO
from pathlib import Path

import pandas as pd
import requests

log = logging.getLogger("universes")
CACHE = Path(__file__).parent / "data" / "universes.json"
UA = {"User-Agent": "Mozilla/5.0 (MagicFormulaScreener; educational project)"}

IBEX35 = [
    "ACS.MC", "ACX.MC", "AENA.MC", "AMS.MC", "ANA.MC", "ANE.MC", "BBVA.MC", "BKT.MC",
    "CABK.MC", "CLNX.MC", "COL.MC", "ELE.MC", "ENG.MC", "FDR.MC", "FER.MC", "GRF.MC",
    "IAG.MC", "IBE.MC", "IDR.MC", "ITX.MC", "LOG.MC", "MAP.MC", "MRL.MC", "MTS.MC",
    "NTGY.MC", "PUIG.MC", "RED.MC", "REP.MC", "ROVI.MC", "SAB.MC", "SAN.MC", "SCYR.MC",
    "SLR.MC", "TEF.MC", "UNI.MC",
]

EUROSTOXX50 = [
    "ADS.DE", "ADYEN.AS", "AD.AS", "AI.PA", "AIR.PA", "ALV.DE", "ABI.BR", "ARGX.BR",
    "ASML.AS", "CS.PA", "BAS.DE", "BAYN.DE", "BBVA.MC", "SAN.MC", "BMW.DE", "BNP.PA",
    "DB1.DE", "DBK.DE", "DHL.DE", "DTE.DE", "ENEL.MI", "ENI.MI", "EL.PA", "RACE.MI",
    "IBE.MC", "ITX.MC", "IFX.DE", "INGA.AS", "ISP.MI", "OR.PA", "MC.PA", "MBG.DE",
    "MUV2.DE", "NDA-FI.HE", "PRX.AS", "RHM.DE", "SAF.PA", "SAN.PA", "SAP.DE", "SU.PA",
    "SIE.DE", "ENR.DE", "STLAM.MI", "TTE.PA", "UCG.MI", "DG.PA", "VOW3.DE", "WKL.AS",
    "BN.PA", "UMG.AS",
]

# Fallback mínimo si Wikipedia no responde y no hay caché
SP500_FALLBACK = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "BRK-B", "AVGO", "TSLA", "LLY",
    "JPM", "V", "XOM", "UNH", "MA", "JNJ", "PG", "HD", "COST", "ABBV", "MRK", "CVX",
    "KO", "PEP", "ADBE", "WMT", "CRM", "CSCO", "MCD", "ACN", "ORCL", "TMO", "ABT",
    "LIN", "DHR", "NKE", "TXN", "QCOM", "AMGN", "HON", "LOW", "UPS", "CAT", "IBM",
    "GILD", "MO", "BKNG", "DE", "MMM", "HPQ",
]
NDX_FALLBACK = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "COST", "NFLX",
    "AMD", "PEP", "ADBE", "CSCO", "QCOM", "TXN", "INTU", "AMAT", "BKNG", "ISRG",
]

META = {
    "sp500": {"name": "S&P 500", "region": "EE. UU.", "currency": "USD"},
    "ndx": {"name": "Nasdaq-100", "region": "EE. UU.", "currency": "USD"},
    "ibex": {"name": "IBEX 35", "region": "España", "currency": "EUR"},
    "sx5e": {"name": "Euro Stoxx 50", "region": "Eurozona", "currency": "EUR"},
}


def _wiki_table(url: str, col_candidates: list[str]) -> list[str]:
    html = requests.get(url, headers=UA, timeout=20).text
    for table in pd.read_html(StringIO(html)):
        for col in col_candidates:
            if col in table.columns:
                syms = table[col].astype(str).str.strip().str.replace(".", "-", regex=False)
                syms = [s for s in syms if s and s.replace("-", "").isalnum() and len(s) <= 6]
                if len(syms) > 50:
                    return syms
    raise ValueError(f"No ticker table found at {url}")


def load_universes(max_age_h: float = 24 * 7) -> dict[str, list[str]]:
    cached = {}
    if CACHE.exists():
        cached = json.loads(CACHE.read_text())
        if time.time() - cached.get("_ts", 0) < max_age_h * 3600:
            return {k: v for k, v in cached.items() if k != "_ts"}

    out = {"ibex": IBEX35, "sx5e": EUROSTOXX50}
    ts = time.time()
    for key, url, cols, fb in [
        ("sp500", "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", ["Symbol"], SP500_FALLBACK),
        ("ndx", "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies", ["Ticker", "Symbol"], NDX_FALLBACK),
    ]:
        try:
            out[key] = _wiki_table(url, cols)
            log.info("Universe %s: %d tickers from Wikipedia", key, len(out[key]))
        except Exception as e:  # noqa: BLE001
            log.warning("Universe %s download failed (%s); using cache/fallback", key, e)
            out[key] = cached.get(key) or fb
            ts = time.time() - max_age_h * 3600 + 3600  # reintentar en 1 h

    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps({**out, "_ts": ts}))
    return out
