"""Europa: Magic Formula rolling por tercios con tramos de 10 y de 30, y panel con TODAS las empresas del STOXX 600.

Rolling: cada 31/12 se compra un tramo con las N primeras del ranking y se mantiene 3 años (la cartera tiene
siempre tres tramos con el mismo peso). La rentabilidad de cada tramo se mide con el índice de rentabilidad total
de cada empresa aunque haya salido del STOXX 600; si deja de cotizar, su último valor se mantiene (liquidez).

Panel completo: todos los miembros del índice cada año, también los que la fórmula excluye, con el motivo.
Salidas en resultados/: rolling_europa.csv y panel_completo_europa.csv (no se suben a GitHub).
"""
import contextlib
import importlib.util
import io
import os

import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bt", os.path.join(BASE, "backtest_europa.py"))
bt = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(bt)

ANIOS = range(2005, 2025)          # fecha de rebalanceo: 31/12 de cada año; la tenencia es el año siguiente
tr = {a: bt.valor_a("tr", f"{a}-12-31") for a in range(2005, 2026)}


def ret_anio(tickers, anio):
    # Rentabilidad total de cada empresa en 'anio' (de 31/12/anio-1 a 31/12/anio), esté o no en el índice
    r = tr[anio].reindex(tickers) / tr[anio - 1].reindex(tickers) - 1
    return r.clip(-1, 5)


# ------------------------------------------------------------------ rolling por tercios
cohortes = {10: {}, 15: {}, 30: {}}
for a in ANIOS:
    rk = bt.ranking(bt.foto(a), "ebit")
    for n in cohortes:
        cohortes[n][a + 1] = list(rk.head(n).index)        # tramo comprado el 31/12/a, primer año de tenencia a+1

filas = []
for t in range(2006, 2026):
    fila = {"anio": t}
    fila["mf_ltm"] = ret_anio(cohortes[30][t], t).fillna(0).mean()
    # (columna, tamaño del tramo, años que se mantiene cada tramo): tercios = 3 años, mitades = 2 años
    for col, n, k in [("rolling10", 10, 3), ("rolling30", 30, 3), ("mitades15", 15, 2), ("mitades30", 30, 2)]:
        tramos = [ret_anio(cohortes[n][f], t).fillna(0).mean() for f in range(t, t - k, -1) if f in cohortes[n]]
        fila[col] = np.mean(tramos) if len(tramos) == k else np.nan
    filas.append(fila)
roll = pd.DataFrame(filas).set_index("anio")
ref = pd.read_csv(os.path.join(BASE, "resultados", "rentabilidad_anual_europa.csv"), index_col=0)
roll = roll.join(ref[["indice_cap", "indice_eq"]])
roll.to_csv(os.path.join(BASE, "resultados", "rolling_europa.csv"))

cagr = lambda s: (1 + s.dropna()).prod() ** (1 / s.dropna().size) - 1
print("CAGR 2008-2025:", {c: round(cagr(roll.loc[2008:, c]) * 100, 2) for c in roll.columns})

# rentabilidad de cada cartera de 30 en su 1.er, 2.º y 3.er año, aunque sus empresas salgan del índice
ev = []
for f in sorted(cohortes[30]):
    for h in (0, 1, 2):
        t = f + h
        if t in ref.index:
            r = ret_anio(cohortes[30][f], t).fillna(0).mean()
            ev.append({"formada": f, "anio_tenencia": h + 1, "ret": r, "exceso_cap": r - ref.loc[t, "indice_cap"],
                       "exceso_eq": r - ref.loc[t, "indice_eq"]})
ev = pd.DataFrame(ev)
ev.to_csv(os.path.join(BASE, "resultados", "tenencia_europa.csv"), index=False)
print(ev.groupby("anio_tenencia")[["ret", "exceso_cap", "exceso_eq"]].mean().round(4))

# ------------------------------------------------------------------ panel con todas las empresas
panel = []
for a in [2004] + list(ANIOS) + [2025]:               # 2025: ranking vigente hoy (cartera de 2026), sin rentabilidad aún
    f = bt.foto(a)
    rk = bt.ranking(f.assign(ret=f.ret.fillna(0)) if a == 2025 else f, "ebit")
    rk["puesto"] = np.arange(1, len(rk) + 1)
    sec = f.sector
    motivo = np.select(
        [sec.eq("Financials") | f.nombre.isin(bt.SIN_SECTOR_EXCLUIDAS), sec.eq("Utilities"), sec.eq("Real Estate"),
         f.ebit.isna() | f.act_corr.isna() | f.pas_corr.isna(), f.ebit.le(0), f.ev.le(0) | f.capital.le(0) | f.mcap.isna(),
         f.ret.isna() & (a < 2025)],
        ["Financiera", "Utility", "Inmobiliaria", "Sin cuentas completas", "EBIT negativo", "EV o capital no válidos",
         "Sin rentabilidad"], default="Elegible")
    g = f.assign(motivo=motivo, puesto=rk.puesto.reindex(f.index), ey=f.ebit / f.ev, roc=f.ebit / f.capital,
                 ret_anio=f.ret.clip(-1, 5), anio=a + 1)
    panel.append(g.reset_index()[["anio", "ticker", "nombre", "pais", "sector", "motivo", "mcap", "ev", "ebit",
                                  "ebit_fwd", "capital", "ey", "roc", "puesto", "ret_anio"]])
panel = pd.concat(panel, ignore_index=True)
panel.to_csv(os.path.join(BASE, "resultados", "panel_completo_europa.csv"), index=False)
print(f"Panel completo: {len(panel):,} filas, {panel.ticker.nunique():,} empresas")
print(panel.motivo.value_counts().to_dict())
