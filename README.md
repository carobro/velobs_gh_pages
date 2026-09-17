# VelObserver — Risikoscore (GitHub Pages)

Statischer, rein clientseitiger Build des **Risikoscore**-Tools
(`bildanalyse-velobserver/velobserver-tools/risikoscore-tool` auf dem
`main`-Branch) für GitHub Pages.

**Echte Berechnung, kein Mockup.** Anders als eine reine UI-Demo führt diese
Seite die tatsächliche Scoring-Engine aus: `veloscore.js` ist eine 1:1-Portierung
von `veloscore.py` (bilineare Interpolation der Kernmatrix, Aggregation
α·max + (1−α)·Ø, Interaktionszuschläge). `config.default.json` ist die aus
`config.yaml` generierte Wissensbasis (Führungsformen, Matrizen, Modifikatoren).
Der Konfigurationseditor validiert Änderungen mit derselben Logik wie
`app.py` (`build_config`, portiert als `VeloScore.buildRiskConfig`).

**Kein Backend.** GitHub Pages kann die Flask-App nicht ausführen, daher
entfallen:
- SQLite-Protokollierung jeder Berechnung (`data/survey.db`)
- CSV-Export (`/export/berechnungen.csv`)
- Persistentes Schreiben von `config.yaml` auf einem Server

Konfigurationsänderungen im Editor werden stattdessen nur in
`localStorage` dieses Browsers abgelegt (Schlüssel `risikoscore_config_v1`) —
sie sind weder mit anderen Nutzenden noch mit der echten `config.yaml` auf
`main` geteilt. „Werkseinstellungen" setzt sie zurück.

Dieser Branch (`gh-pages-demo`) ist bewusst von `main` losgelöst (eigene,
von main unabhängige Historie) und enthält nur die für diesen Build nötigen
statischen Dateien.

## Dateien
- `index.html` — Seite (Formular aus Eingaben, Konfigurationseditor)
- `style.css` — unverändertes VelObserver-Styling des Original-Tools
- `veloscore.js` — Scoring-Engine + Config-Validierung (Port aus Python)
- `config.default.json` — Wissensbasis, generiert aus `config.yaml`
- `logo.jpg` — VelObserver-Logo

## Aktualisieren
Bei Änderungen an `risikoscore-tool/veloscore.py`, `app.py` (`build_config`)
oder `config.yaml` auf `main` müssen die entsprechenden Teile hier von Hand
nachgezogen werden (kein automatischer Build-Schritt).

## Aktivieren
Repo-Settings → Pages → Source: "Deploy from a branch" →
Branch `gh-pages-demo`, Ordner `/ (root)`.
