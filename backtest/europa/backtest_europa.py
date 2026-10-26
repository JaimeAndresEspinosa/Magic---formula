"""Backtest de la Magic Formula en Europa (STOXX Europe 600), 2006-2025, con datos de Bloomberg.

Compara dos versiones de la fórmula:
  - LTM: EBIT del último ejercicio publicado (Greenblatt original).
  - Forward: EBIT previsto por el consenso de analistas a 12 meses (BEST_EBIT), vigente en la fecha.

Reglas (point-in-time):
  - Rebalanceo a 31/12 de cada año Y (2005-2024); se mantiene hasta 31/12/Y+1.
  - Universo: miembros del STOXX Europe 600 a 31/12/Y (incluye empresas que luego desaparecieron).
  - Cuentas: último dato con fecha de cierre <= 30/06/Y (desfase de 6 meses para no usar cuentas no publicadas).
  - Capitalización a 31/12/Y. EV = capitalización + deuda CP + deuda LP - caja (cuentas con desfase).
  - EY = EBIT / EV; ROC = EBIT / (max(circulante neto, 0) + inmovilizado neto).
  - Se excluyen financieras, utilities e inmobiliarias cuando el sector es conocido; los bancos y aseguradoras
    sin sector también quedan fuera porque no publican activo/pasivo corriente.
  - Top 30 equiponderado. Rentabilidad = índice de rentabilidad total (dividendos brutos reinvertidos), en EUR.
  - Referencias: el mismo universo ponderado por capitalización (réplica del STOXX 600) y equiponderado.
"""
import os

import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(BASE, "datos")
OUT = os.path.join(BASE, "resultados")
os.makedirs(OUT, exist_ok=True)
TOP_N = 30
EXCLUIDOS = {"Financials", "Utilities", "Real Estate"}
# Empresas sin sector en Bloomberg (ya no cotizan con ese código) que son financieras, utilities o inmobiliarias
SIN_SECTOR_EXCLUIDAS = {"ABRDN HOLDINGS LTD", "HARGREAVES LANSDOWN LTD", "SCHRODERS PLC", "JARDINE LLOYD THOMPSON GROUP",
                        "NEX GROUP PLC", "TULLET PREBON GROUP HOLDINGS", "G CITY EUROPE LTD", "EDF ENERGY NUCLEAR GENERATIO"}

carga = lambda n: pd.read_pickle(os.path.join(D, f"{n}.pkl"))
mem, info = carga("miembros"), carga("info").set_index("ticker")
series = {n: carga(n) for n in ["ebit_fwd", "ebit", "act_corr", "pas_corr", "caja", "deuda_cp", "deuda_lp",
                                "inmov", "mcap", "tr"]}


def valor_a(campo, fecha, retardo_meses=0):
    """Último valor de cada empresa con fecha <= fecha - retardo."""
    df = series[campo]
    lim = pd.Timestamp(fecha) - pd.DateOffset(months=retardo_meses)
    df = df[df.fecha <= lim]
    return df.sort_values("fecha").groupby("ticker")[campo].last()


def foto(anio):
    """Variables de cada miembro del índice a 31/12/anio."""
    fin = pd.Timestamp(f"{anio}-12-31")
    t = mem.loc[mem.anio == anio, "ticker"].unique()
    f = pd.DataFrame(index=pd.Index(t, name="ticker"))
    for c in ["ebit", "act_corr", "pas_corr", "caja", "deuda_cp", "deuda_lp", "inmov"]:
        f[c] = valor_a(c, f"{anio}-06-30").reindex(f.index)
    f["mcap"] = valor_a("mcap", fin).reindex(f.index)
    f["ebit_fwd"] = valor_a("ebit_fwd", fin).reindex(f.index)
    f["tr0"] = valor_a("tr", fin).reindex(f.index)
    f["tr1"] = valor_a("tr", f"{anio + 1}-12-31").reindex(f.index)
    f["sector"] = info["sector"].reindex(f.index)
    f["nombre"] = info["nombre"].reindex(f.index)
    f["pais"] = info["pais"].reindex(f.index)
    for c in ["caja", "deuda_cp", "deuda_lp"]:
        f[c] = f[c].fillna(0)
    f["ev"] = f.mcap + f.deuda_cp + f.deuda_lp - f.caja
    nwc = (f.act_corr - f.caja) - (f.pas_corr - f.deuda_cp)
    f["capital"] = nwc.clip(lower=0) + f.inmov
    f["ret"] = f.tr1 / f.tr0 - 1
    return f


def ranking(f, col_ebit):
    ok = (~f.sector.isin(EXCLUIDOS) & ~f.nombre.isin(SIN_SECTOR_EXCLUIDAS) & f[col_ebit].gt(0) & f.ev.gt(0) & f.capital.gt(0)
          & f.act_corr.notna() & f.pas_corr.notna() & f.ret.notna())
    g = f[ok].copy()
    g["ey"] = g[col_ebit] / g.ev
    g["roc"] = g[col_ebit] / g.capital
    g["puntos"] = g.ey.rank(ascending=False) + g.roc.rank(ascending=False)
    return g.sort_values(["puntos", "ey"], ascending=[True, False])


filas, carteras = [], []
for anio in range(2005, 2025):
    f = foto(anio)
    base = f[f.ret.notna() & f.mcap.gt(0)]
    r = {"anio": anio + 1,
         "indice_cap": np.average(base.ret.clip(-1, 5), weights=base.mcap),
         "indice_eq": base.ret.clip(-1, 5).mean()}
    for nombre, col in [("mf_ltm", "ebit"), ("mf_fwd", "ebit_fwd")]:
        top = ranking(f, col).head(TOP_N)
        r[nombre] = top.ret.clip(-1, 5).mean()
        r[f"n_{nombre}"] = len(top)
        r[f"elegibles_{nombre}"] = len(ranking(f, col))
        for i, (t, x) in enumerate(top.iterrows(), 1):
            carteras.append({"anio": anio + 1, "version": nombre, "puesto": i, "ticker": t, "nombre": x.nombre,
                             "pais": x.pais, "sector": x.sector, "ey": x.ey, "roc": x.roc, "ret": x.ret})
    # solape entre las dos carteras
    a = set(ranking(f, "ebit").head(TOP_N).index); b = set(ranking(f, "ebit_fwd").head(TOP_N).index)
    r["solape"] = len(a & b)
    filas.append(r)

res = pd.DataFrame(filas).set_index("anio")
car = pd.DataFrame(carteras)
res.to_csv(os.path.join(OUT, "rentabilidad_anual_europa.csv"))
car.to_csv(os.path.join(OUT, "carteras_europa.csv"), index=False)

cols = ["mf_ltm", "mf_fwd", "indice_cap", "indice_eq"]
def met(s):
    v = (1 + s).cumprod()
    return {"CAGR": v.iloc[-1] ** (1 / len(s)) - 1, "vol": s.std(), "peor_anio": s.min(),
            "dd": (v / v.cummax() - 1).min(), "final_10k": 10000 * v.iloc[-1]}
resumen = pd.DataFrame({c: met(res[c]) for c in cols}).T
for c in ["mf_ltm", "mf_fwd"]:
    resumen.loc[c, "anios_sobre_cap"] = int((res[c] > res.indice_cap).sum())
    resumen.loc[c, "anios_sobre_eq"] = int((res[c] > res.indice_eq).sum())
resumen.to_csv(os.path.join(OUT, "resumen_europa.csv"))
pd.set_option("display.width", 200)
print(res.round(4))
print(resumen.round(4))
