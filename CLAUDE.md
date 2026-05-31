# FM RUN — Workflow-Regeln für Claude

**Diese Datei IMMER lesen und beherzigen, bevor irgendetwas editiert wird.**

---

## REGEL 1 (UNVERHANDELBAR): Pull from GitHub main BEFORE editing

Am Repo arbeitet nicht nur ich (Claude), sondern auch ein menschlicher Kollege.
Sein Code (Ranking-System, Supabase-Migrations, accountChip-UI, etc.) darf NIE
überschrieben werden.

**Vor jedem Edit muss der aktuelle Stand von `origin/main` gezogen werden:**

```bash
cd /tmp/fm-run-fresh
git fetch origin main
git log --oneline HEAD..origin/main   # zeigt neue Commits vom Kollegen
```

Wenn `HEAD..origin/main` neue Commits enthält:
1. **STOPP** — nicht einfach drüberbügeln
2. `git pull origin main` (oder `git reset --hard origin/main` falls lokal nichts wichtiges)
3. Erst danach lokale Änderungen in `outputs/` anfangen

**Niemals** lokale `outputs/index.html` blind ins Repo kopieren, ohne vorher zu
prüfen, ob es zwischenzeitlich neue Commits gibt.

---

## Repository-Setup

- **GitHub:** `github.com/louftmkz/fm-run` (main branch)
- **Deploy:** Vercel pullt automatisch von `main`
- **Working Clone:** `/tmp/fm-run-fresh` (im Sandbox-Workspace)
- **Edit-Pfad:** `/Users/louftmkz/Desktop/LOU/JOBS/APPS/FM Run` (= outputs/ im File-Tool)
- **Push-Identität:** `Lou Kailich <lou.kailich@acture.de>`

## Standard-Workflow für jeden Edit-Schritt

1. **Pull** (siehe Regel 1)
2. **TaskCreate** + TaskUpdate `in_progress` für den neuen Step
3. **Edit** Files in `outputs/`
4. **Verify**: Read-back oder Grep, dass Änderung sauber sitzt
5. **Copy** `outputs/*` → `/tmp/fm-run-fresh/`
6. **Bump** Service-Worker Cache-Version (`CACHE_NAME = 'fm-run-vNN'`)
7. **Commit** mit aussagekräftiger Step-NN Message
8. **Push** `git push origin main`
9. **TaskUpdate** `completed`

## Architektur-Notizen

- **Single-File-Game:** `index.html` enthält CSS + HTML + JS in einem File
- **PWA:** Service Worker cached alle Assets (`service-worker.js` PRECACHE-Liste)
- **Vanilla JS** in IIFE — keine Build-Pipeline, alles im Browser direkt
- **Canvas 2D** für Rendering, `requestAnimationFrame` Loop
- **Pixel-Art** Style: `image-rendering: pixelated`, Sprites werden nicht geblurt
- **Game-Loop States:** `READY | PLAYING | SLIDING | FALLING | OVER`

## Tabu-Bereiche (Kollegen-Domain — nur in Absprache anfassen)

- `ranking.js` — komplettes Supabase-Auth + Best-Score-Submission
- `supabase/migrations/` — DB-Schema
- accountChip / Modal-UI in `index.html` (Ranking-Sektion)

## Häufige Stolperfallen

- **TDZ-Crash bei const inside draw()**: Glow-Helper müssen Module-Level sein
- **iOS Touch-Action**: `body{touch-action:none}` blockt Slider-Drag — pro Element überschreiben mit `touch-action:pan-x`
- **Audio Performance**: `Audio.cloneNode()` killt iOS-Framerate — Web Audio API verwenden (`AudioContext` + `decodeAudioData` + `BufferSourceNode`)
- **Spawn-Konflikte**: Gaps + Ramps brauchen `SAFE_AFTER_RAMP`-Buffer in BEIDE Richtungen (spawnGap UND spawnRamp prüfen)
- **Sprite-Hitbox vs Visual**: optional `o.hitInsetX` erlaubt visuell breite, hitbox-schmale Obstacles

## Verbotene Aktionen

- `git push --force` (würde Kollegen-Commits killen)
- Direktes Editieren in `/tmp/fm-run-fresh/index.html` (Edits kommen aus `outputs/`)
- Service Worker ohne Cache-Bump deployen (User sieht alte Version)
- `api.github.com` Zugriff (gesperrt) — nur `github.com` per `git push`
