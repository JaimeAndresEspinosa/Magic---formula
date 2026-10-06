# Magic Formula Screener

Web que aplica en tiempo real la **Magic Formula de Joel Greenblatt** sobre el
S&P 500, el Nasdaq-100, el IBEX 35 y el Euro Stoxx 50, con precios y estados
financieros reales de Yahoo Finance.

**Web publicada: https://magic-formula-wc0j.onrender.com**

## Qué hace

- **Ranking**: ordena las empresas por *Earnings Yield* (EBIT / EV) y por
  *Return on Capital* (EBIT / (capital circulante neto + inmovilizado neto)),
  suma los dos puestos y muestra las mejores. Se puede filtrar por
  capitalización mínima, sector y texto, y exportar a CSV.
- **Dos formas de calcular el ROC**: la original de Greenblatt (solo capital
  tangible) o una variante que suma el fondo de comercio e intangibles, para no
  premiar a las empresas que crecen comprando otras caras y con deuda.
- **Precios en vivo**: el servidor refresca cotizaciones aproximadamente cada minuto con mercado
  abierto (cada 5 min con mercado cerrado). Como el EV depende del precio, el
  Earnings Yield y el ranking se recalculan en cada refresco. La web consulta al
  servidor cada 10 s y resalta en verde o rojo los precios que cambian.
- **Ficha de empresa**: gráfico de precio (1D a 5A) y el desglose completo del
  cálculo de EV, EY, capital invertido y ROC, con la fuente del EBIT (TTM o anual).
- **Cartera**: reparte un importe a partes iguales entre las primeras 10, 20 o 30
  del ranking, calcula cuántas acciones comprar y la exposición por sector.
- **Simulación**: guarda las primeras empresas del ranking con el precio del
  momento y sigue su evolución frente al índice, sin dinero real. Se guarda en
  el navegador y se puede abrir en otro dispositivo con «Copiar enlace».
- **Metodología**: explicación de la fórmula, de los datos y de sus limitaciones.

## Cómo arrancarla

En Windows, haz doble clic en **`iniciar.bat`**: instala las dependencias, arranca
el servidor y abre el navegador en http://localhost:8000.

O a mano:

```bash
pip install -r requirements.txt
python -m uvicorn app:app --port 8000
```

La **primera vez** el servidor descarga los estados financieros de unas 600
empresas. Tarda unos 10–15 minutos porque Yahoo limita el número de peticiones.
La web ya funciona mientras tanto y muestra una barra de progreso. Después se
guardan en `data/fundamentals.json` y se renuevan cada 24 h, así que los
siguientes arranques son inmediatos.

## Estructura

| Archivo | Contenido |
|---|---|
| `app.py` | API FastAPI, descarga de fundamentales y precios, cálculo de EY / ROC |
| `universes.py` | Composición de los índices (Wikipedia para S&P 500 y Nasdaq-100; IBEX 35 y Euro Stoxx 50 fijos) |
| `static/` | Web (HTML, CSS y JavaScript sin dependencias) |
| `data/` | Caché local (se crea sola) |

### API

| Endpoint | Devuelve |
|---|---|
| `GET /api/status` | Progreso de la descarga, estado de los mercados, última actualización |
| `GET /api/ranking/{sp500,ndx,ibex,sx5e}` | Métricas en vivo de cada empresa del universo |
| `GET /api/stock/{ticker}` | Ficha y desglose de una empresa |
| `GET /api/history/{ticker}?range=1d\|5d\|1m\|6m\|1y\|5y` | Serie de precios |

El ranking se hace en el navegador, así que los filtros (p. ej. la capitalización
mínima) recalculan los puestos al instante.

## Publicarla en Internet

Cualquier servicio que ejecute Python sirve. Por ejemplo, en **Render**
(render.com):

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: *New → Web Service* y elige el repositorio.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn app:app --host 0.0.0.0 --port $PORT`

En el plan gratuito el servidor se duerme tras 15 min sin visitas y pierde la
caché al reiniciarse, así que la primera carga vuelve a tardar. Para una demo
estable conviene un plan con disco persistente, o Railway / Fly.io.

## Notas sobre los datos

- Las cotizaciones de EE. UU. son prácticamente en tiempo real. Las europeas
  pueden ir hasta 15 min retrasadas según la bolsa.
- Yahoo Finance es una fuente gratuita y no oficial: puede tener huecos o
  errores puntuales. Para un uso profesional se puede cambiar `fetch_fundamentals`
  por un proveedor de pago (Financial Modeling Prep, EODHD, Refinitiv…).
- Se excluyen financieras, utilities e inmobiliarias (en el libro las inmobiliarias se clasificaban como financieras).
- Las listas fijas de IBEX 35 y Euro Stoxx 50 están en `universes.py` y hay que
  actualizarlas cuando cambie la composición de los índices.

---

Herramienta educativa. No constituye asesoramiento financiero.
