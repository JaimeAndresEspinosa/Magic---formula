"""Convierte las hojas de Bloomberg (2 columnas por empresa: fecha, valor) en tablas largas
y las guarda en parquet para el backtest europeo. Los datos no se suben a GitHub."""
import os
import pandas as pd
from openpyxl import load_workbook

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "..", "bloomberg", "DATOS_BLOOMBERG_2026-10-26.xlsx")
OUT = os.path.join(BASE, "datos")
os.makedirs(OUT, exist_ok=True)

SERIES = {"EBIT_PREVISTO_EUROPA": "ebit_fwd", "EUROPA_EBIT": "ebit", "EUROPA_ACTIVO_CORR": "act_corr",
          "EUROPA_PASIVO_CORR": "pas_corr", "EUROPA_CAJA": "caja", "EUROPA_DEUDA_CP": "deuda_cp",
          "EUROPA_DEUDA_LP": "deuda_lp", "EUROPA_INMOVILIZADO": "inmov", "EUROPA_CAPITALIZACION": "mcap",
          "EUROPA_EV": "ev_bbg", "EUROPA_RENTAB_TOTAL": "tr"}

wb = load_workbook(SRC, read_only=True)


def larga(sheet, campo):
    rows = list(wb[sheet].iter_rows(values_only=True))
    hdr = rows[0]
    out = []
    for c in range(0, len(hdr), 2):
        t = hdr[c]
        if not isinstance(t, str) or not t.endswith("Equity"):
            continue
        for r in rows[1:]:
            d, v = r[c], (r[c + 1] if c + 1 < len(r) else None)
            if d is None or not hasattr(d, "year"):
                continue
            if isinstance(v, (int, float)):
                out.append((t, pd.Timestamp(d), float(v)))
    df = pd.DataFrame(out, columns=["ticker", "fecha", campo]).drop_duplicates(["ticker", "fecha"], keep="last")
    return df


for sh, campo in SERIES.items():
    df = larga(sh, campo)
    df.to_pickle(os.path.join(OUT, f"{campo}.pkl"))
    print(f"{campo:10s} {len(df):7d} filas  {df.ticker.nunique():5d} empresas")

# Composición del STOXX Europe 600 a 31/12 de cada año
rows = list(wb["EMPRESAS_EUROPA"].iter_rows(values_only=True))
hdr = rows[0]
mem = []
for c, h in enumerate(hdr):
    if isinstance(h, str) and h.startswith("SXXP Index"):
        anio = int(h.split()[-1])
        for r in rows[1:]:
            t = r[c]
            if isinstance(t, str) and not t.startswith("#"):
                mem.append((anio, t + " Equity"))
mem = pd.DataFrame(mem, columns=["anio", "ticker"]).drop_duplicates()
mem.to_pickle(os.path.join(OUT, "miembros.pkl"))
print("miembros", mem.groupby("anio").size().to_dict())

rows = list(wb["DATOS_EMPRESAS_EUROPA"].iter_rows(values_only=True))
info = pd.DataFrame([r[:7] for r in rows[1:] if r[0]], columns=["ticker", "nombre", "cusip", "isin", "sector", "divisa", "pais"])
info = info.replace({"#N/A N/A": None, "": None})
info.to_pickle(os.path.join(OUT, "info.pkl"))
print("info", len(info), "sector conocido", info.sector.notna().sum())
print(info.sector.value_counts().to_dict())
