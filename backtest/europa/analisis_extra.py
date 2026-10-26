"""Métricas adicionales del backtest europeo: optimismo de los analistas, rotación, países y sectores."""
import importlib.util, os
import numpy as np, pandas as pd
spec = importlib.util.spec_from_file_location("bt", "backtest_europa.py"); bt = importlib.util.module_from_spec(spec)
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(bt)
car = pd.read_csv("resultados/carteras_europa.csv")
# 1. Error de previsión: EBIT real del ejercicio siguiente frente al previsto
err_top, err_all = [], []
for anio in range(2005, 2024):
    f = bt.foto(anio)
    real = bt.valor_a("ebit", f"{anio + 1}-12-31").reindex(f.index)
    g = bt.ranking(f, "ebit_fwd")
    e = (real / g.ebit_fwd - 1).replace([np.inf, -np.inf], np.nan).dropna()
    err_all.append(e)
    err_top.append(e.reindex(g.head(30).index).dropna())
ea, et = pd.concat(err_all), pd.concat(err_top)
print("Error mediano EBIT real vs previsto | universo:", round(ea.median()*100,1), "% | top30 forward:", round(et.median()*100,1), "%")
print("% casos real < previsto | universo:", round((ea<0).mean()*100,1), "| top30:", round((et<0).mean()*100,1))
# 2. Rotación anual
for v in ["mf_ltm", "mf_fwd"]:
    c = car[car.version == v]; rot = []
    for a in range(2007, 2026):
        prev = set(c[c.anio == a-1].ticker); cur = set(c[c.anio == a].ticker)
        if prev: rot.append(len(cur - prev) / 30)
    print(v, "rotación media", round(np.mean(rot)*100), "%")
# 3. Países y sectores (todas las carteras LTM)
c = car[car.version == "mf_ltm"]
print(c.pais.value_counts(normalize=True).head(8).round(3).to_dict())
print(c.sector.fillna("Sin dato").value_counts(normalize=True).head(8).round(3).to_dict())
print(c.nombre.value_counts().head(10).to_dict())
print("España en carteras LTM:", (c.pais=="ES").sum(), sorted(c[c.pais=="ES"].nombre.unique()))
print("Cartera 2025 LTM:", c[c.anio==2025].nombre.tolist())
