# FM RUN

PWA Endless-Runner. Vier Helden, je eine Spezialfaehigkeit — du musst zum passenden Charakter switchen, bevor das jeweilige Element dich erreicht.

## Helden

| Held | Farbe | Element |
|---|---|---|
| **Lou** | gelb | Rampen (klettert hoch) |
| **Sasch** | gruen | Hindernisse (zerschlaegt) |
| **Shizzo** | rot | Coins (sammelt) |
| **LonG** | blau | Loecher (springt automatisch) |

## Spielen

Direkt im Browser. Mobile: aus dem Browser zum Home-Screen hinzufuegen — laeuft als installierte App (PWA, offline-faehig).

## Lokal entwickeln

Static — kein Build noetig. Beliebigen Static-Server in den Ordner werfen:

```bash
python3 -m http.server 8080
# oder
npx serve
```

## Deploy

Auto-Deploy via Vercel (verbunden mit dem `main`-Branch dieses Repos).
