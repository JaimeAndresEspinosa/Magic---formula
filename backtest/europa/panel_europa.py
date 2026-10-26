"""Construye el panel empresa-año de Europa (mismo formato que panel_eeuu.csv de WRDS) para el análisis conjunto.

Columnas: anio (rebalanceo a 31/12/anio-1 -> se mantiene en anio), ticker, nombre, pais, sector, mcap, ev, ebit (LTM con
desfase de 6 meses), ebit_fwd, ebit_real_sig (EBIT del ejercicio siguiente), ebit_sin_desfase (para medir el sesgo de
anticipación), capital, ey, roc, puesto, ret_anio, superviviente (sigue en el índice a 31/12/2025).
"""
import importlib.util
import contextlib
import io
import os

import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bt", os.path.join(BASE, "backtest_europa.py"))
bt = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(bt)

supervivientes = set(bt.mem.loc[bt.mem.anio == 2025, "ticker"])
filas = []
for anio in range(2004, 2025):
    f = bt.foto(anio)
    f["ebit_sin_desfase"] = bt.valor_a("ebit", f"{anio}-12-31").reindex(f.index)
    f["ebit_real_sig"] = bt.valor_a("ebit", f"{anio + 1}-12-31").reindex(f.index)
    excl = f.sector.isin(bt.EXCLUIDOS) | f.nombre.isin(bt.SIN_SECTOR_EXCLUIDAS)
    ok = (~excl & f.ev.gt(0) & f.capital.gt(0) & f.act_corr.notna() & f.pas_corr.notna() & f.ret.notna())
    g = f[ok].copy()
    g["ey"] = g.ebit / g.ev
    g["roc"] = g.ebit / g.capital
    elig = g[g.ebit > 0]
    puntos = elig.ey.rank(ascending=False) + elig.roc.rank(ascending=False)
    g["puesto"] = puntos.rank(method="first").reindex(g.index)
    g["anio"] = anio + 1
    g["ret_anio"] = g.ret.clip(-1, 5)
    g["superviviente"] = g.index.isin(supervivientes)
    filas.append(g.reset_index()[["anio", "ticker", "nombre", "pais", "sector", "mcap", "ev", "ebit", "ebit_fwd",
                                  "ebit_real_sig", "ebit_sin_desfase", "capital", "ey", "roc", "puesto", "ret_anio",
                                  "superviviente"]])
    # índice completo del año (incluidas financieras) para las referencias
panel = pd.concat(filas, ignore_index=True)
out = os.path.join(BASE, "resultados", "panel_europa.csv")
panel.to_csv(out, index=False)
print(f"Panel Europa: {len(panel):,} filas, {panel.ticker.nunique():,} empresas, años {panel.anio.min()}-{panel.anio.max()}")
