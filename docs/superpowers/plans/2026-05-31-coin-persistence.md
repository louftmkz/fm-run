# Server-persistente Coin-Balance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coin-Balance pro User in Supabase persistieren, damit Coins geräte- und sessionübergreifend erhalten bleiben.

**Architecture:** Neue Spalte `coins_balance bigint` auf `profiles`. Neue RPC `add_coins(p_user_id, p_delta)` mit `SECURITY DEFINER` (gleiches Trust-Modell wie `submit_score_by_id`). Client tracked Run-Delta clientseitig, sendet beim Game-Over per RPC zum Server. Login holt Server-Total via existierende `loadProfile`-Query und merged lokale anonyme Coins per Delta-Calculation.

**Tech Stack:** Supabase (Postgres + REST), vanilla JS (`index.html`, `ranking.js`), localStorage.

**Spec:** [`docs/superpowers/specs/2026-05-31-coin-persistence-design.md`](../specs/2026-05-31-coin-persistence-design.md)

**Korrekturen ggü. Spec (aufgrund Code-Verifikation):**
1. Spec sagte `authenticate`-RPC erweitern → tatsächlich nutzt der Client kein `authenticate`-RPC, sondern `sb.from('profiles').select(...)` direkt. Plan erweitert die Selects in `loadProfile` und `signIn` um `coins_balance` statt einer RPC-Änderung.
2. Spec hatte Login-Merge mit `if (localCoins > 0)` — würde bei Tab-Reload zu Doppel-Gutschrift führen. Plan nutzt `if (localCoins > serverCoins) { delta = localCoins - serverCoins }`.
3. Events laufen über `window`, nicht `document` (existierendes Pattern: `index.html:521` für `fmrun:bestSynced`).

---

## File Structure

| Datei | Zweck | Änderungstyp |
|---|---|---|
| `supabase/migrations/0005_coins_balance.sql` | Spalte + RPC | **Create** |
| `ranking.js` | Server-Sync der Coins (load, submit, logout, export) | Modify (~40 LoC) |
| `index.html` | Run-Delta-Tracking + Event-Listener + Game-Over-Hook | Modify (~15 LoC) |

Keine neuen JS-Module, keine neuen Tabellen. Bestehende Boundaries (`ranking.js` = Server-Kommunikation, `index.html` = Spielzustand + UI) bleiben erhalten.

---

## Task 1: Migration anlegen (Schema + RPC)

**Files:**
- Create: `supabase/migrations/0005_coins_balance.sql`

- [ ] **Step 1.1: Migrationsdatei schreiben**

```sql
-- Migration: Persistent coin balance per profile (Phase 1: collect only)
-- Adds coins_balance column to profiles and add_coins RPC for server-side increment.

-- 1. Schema: coins_balance column
ALTER TABLE public.profiles
  ADD COLUMN coins_balance bigint NOT NULL DEFAULT 0
  CHECK (coins_balance >= 0);

-- 2. RPC: add_coins (increment-only, with validation)
CREATE OR REPLACE FUNCTION public.add_coins(p_user_id uuid, p_delta integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance bigint;
BEGIN
  IF p_delta IS NULL OR p_delta < 0 THEN
    RAISE EXCEPTION 'invalid_delta';
  END IF;
  IF p_delta > 1000000 THEN
    RAISE EXCEPTION 'delta_too_large';
  END IF;

  UPDATE public.profiles
     SET coins_balance = coins_balance + p_delta,
         updated_at    = now()
   WHERE id = p_user_id
   RETURNING coins_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  RETURN v_new_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_coins(uuid, integer) TO anon, authenticated;
```

- [ ] **Step 1.2: Migration anwenden**

Bevorzugt via Supabase MCP (Live-Projekt):
```
mcp__supabase__apply_migration with name="0005_coins_balance" and query=<the SQL above>
```

Alternativ via Supabase CLI lokal:
```bash
supabase db push
```

Erwartung: Migration läuft ohne Fehler durch.

- [ ] **Step 1.3: Schema verifizieren**

Via Supabase MCP:
```
mcp__supabase__execute_sql with query="SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='coins_balance';"
```

Erwartung: eine Zeile, `coins_balance | bigint | NO | 0`.

- [ ] **Step 1.4: RPC happy-path testen**

Hole eine existierende profile.id:
```
mcp__supabase__execute_sql with query="SELECT id, handle, coins_balance FROM public.profiles LIMIT 1;"
```

Test add_coins:
```
mcp__supabase__execute_sql with query="SELECT public.add_coins('<UUID-FROM-ABOVE>'::uuid, 100);"
```

Erwartung: Resultat = ursprünglicher Wert + 100.

Zweiter Call:
```
mcp__supabase__execute_sql with query="SELECT public.add_coins('<UUID>'::uuid, 50);"
```

Erwartung: ursprünglicher Wert + 150.

- [ ] **Step 1.5: RPC-Validation testen**

```
mcp__supabase__execute_sql with query="SELECT public.add_coins('<UUID>'::uuid, -1);"
```

Erwartung: Fehler `invalid_delta`.

```
mcp__supabase__execute_sql with query="SELECT public.add_coins('<UUID>'::uuid, 1000001);"
```

Erwartung: Fehler `delta_too_large`.

```
mcp__supabase__execute_sql with query="SELECT public.add_coins('00000000-0000-0000-0000-000000000000'::uuid, 10);"
```

Erwartung: Fehler `profile_not_found`.

- [ ] **Step 1.6: Test-Daten zurücksetzen**

```
mcp__supabase__execute_sql with query="UPDATE public.profiles SET coins_balance = 0 WHERE id = '<UUID>'::uuid;"
```

(Optional, je nachdem ob der Test-User in Phase 5 wiederverwendet wird.)

- [ ] **Step 1.7: Commit**

```bash
git add supabase/migrations/0005_coins_balance.sql
git commit -m "feat(db): add coins_balance column + add_coins RPC

Migration 0005 fügt persistente Coin-Balance ein:
- profiles.coins_balance bigint NOT NULL DEFAULT 0, CHECK >= 0
- add_coins(user_id, delta) SECURITY DEFINER, Cap bei 1M pro Call

Phase 1: nur sammeln, kein Spending."
```

---

## Task 2: ranking.js — coins_balance in bestehende Profile-Queries aufnehmen

**Files:**
- Modify: `ranking.js:58` (loadProfile select)
- Modify: `ranking.js:147` (signIn select)

- [ ] **Step 2.1: loadProfile select erweitern**

Zeile 57-58, ändere von:
```js
const { data, error } = await sb.from('profiles')
  .select('id, handle, best_distance').eq('id', session.userId).maybeSingle();
```
zu:
```js
const { data, error } = await sb.from('profiles')
  .select('id, handle, best_distance, coins_balance').eq('id', session.userId).maybeSingle();
```

- [ ] **Step 2.2: signIn select erweitern**

Zeile 146-149, ändere von:
```js
const { data: profiles, error } = await sb.from('profiles')
  .select('id, handle, password_hash, best_distance')
  .ilike('handle', handle)
  .maybeSingle();
```
zu:
```js
const { data: profiles, error } = await sb.from('profiles')
  .select('id, handle, password_hash, best_distance, coins_balance')
  .ilike('handle', handle)
  .maybeSingle();
```

- [ ] **Step 2.3: Lokale Smoke-Verifikation**

Server in einem Terminal starten (oder dev server, je nach Projekt-Setup):
```bash
# Falls noch kein dev server konfiguriert: simple http server
python3 -m http.server 8000
```

Im Browser `http://localhost:8000` öffnen, DevTools-Konsole. Eingeloggter Status (existierende Session in localStorage).

In Konsole prüfen, dass kein Fehler erscheint und Login weiter funktioniert. (Profile-Daten enthalten jetzt zusätzlich `coins_balance`, werden aber noch nicht genutzt — kein Verhaltens-Change.)

- [ ] **Step 2.4: Commit**

```bash
git add ranking.js
git commit -m "feat(ranking): fetch coins_balance in profile selects

Erweitert loadProfile + signIn Selects um coins_balance.
Wert wird noch nicht verwendet (folgt in nächsten Steps), aber sicher
ohne Verhaltens-Change."
```

---

## Task 3: ranking.js — `submitCoinsDelta` Funktion + Export

**Files:**
- Modify: `ranking.js:183-202` (Score-Submission Block — neue Funktion daneben)
- Modify: `ranking.js:434` (Export-Statement)

- [ ] **Step 3.1: `submitCoinsDelta` einfügen**

Nach Zeile 202 (Ende `submitScore`), VOR der `// ---------- Board-Funktionen ----------`-Markierung in Zeile 204, einfügen:

```js
  // ---------- Coins-Submission ----------
  async function submitCoinsDelta(delta){
    const d = Math.max(0, Math.floor(delta || 0));
    if(!cfgOk() || !session || !session.userId || d <= 0) return;
    try {
      const { data, error } = await sb.rpc('add_coins', {
        p_user_id: session.userId,
        p_delta: d,
      });
      if(error){ console.warn('[ranking] coins sync failed:', error); return; }
      const newTotal = Number(data);
      try { localStorage.setItem('fmrun_coins', String(newTotal)); } catch(e){}
      window.dispatchEvent(new CustomEvent('fmrun:coinsSynced', { detail: { coins: newTotal } }));
    } catch(e){
      console.warn('[ranking] coins sync error:', e);
    }
  }
```

- [ ] **Step 3.2: Export erweitern**

Zeile 434, ändere von:
```js
  window.FMRanking = { init, submitScore };
```
zu:
```js
  window.FMRanking = { init, submitScore, submitCoinsDelta };
```

- [ ] **Step 3.3: Funktion in Konsole testen**

Server läuft (von Step 2.3). Browser auf der App, eingeloggt, DevTools-Konsole:

```js
// Aktuelles coins_balance abfragen (sollte 0 sein nach Step 1.6)
await window.FMRanking.submitCoinsDelta(42);
```

Im Network-Tab den `add_coins`-RPC sehen. Dann localStorage prüfen:
```js
localStorage.getItem('fmrun_coins')
```

Erwartung: `"42"` (oder vorheriger Wert + 42).

Event-Listener-Smoke-Test:
```js
window.addEventListener('fmrun:coinsSynced', e => console.log('synced:', e.detail));
await window.FMRanking.submitCoinsDelta(10);
// Erwartung: console.log "synced: {coins: 52}"
```

- [ ] **Step 3.4: Test-Daten zurücksetzen**

Über Supabase MCP:
```
mcp__supabase__execute_sql with query="UPDATE public.profiles SET coins_balance = 0 WHERE id = '<UUID>'::uuid;"
```

Und localStorage im Browser:
```js
localStorage.setItem('fmrun_coins', '0');
```

- [ ] **Step 3.5: Commit**

```bash
git add ranking.js
git commit -m "feat(ranking): add submitCoinsDelta function + export

Neue Funktion submitCoinsDelta(delta) ruft add_coins-RPC, persistiert
neuen Server-Total in localStorage und feuert fmrun:coinsSynced Event.
Bei Fehler bleibt lokal unverändert (kein Datenverlust).
Exportiert via window.FMRanking.submitCoinsDelta."
```

---

## Task 4: ranking.js — Login-Merge in `loadProfile` + Logout-Reset in `signOut`

**Files:**
- Modify: `ranking.js:60-71` (loadProfile, Bereich nach best-distance-Migration)
- Modify: `ranking.js:178` (signOut Body)

- [ ] **Step 4.1: Login-Merge in loadProfile einfügen**

Zeile 61-71 ist der bestehende best_distance-Migration-Block. NACH `window.dispatchEvent(new CustomEvent('fmrun:bestSynced', ...))` in Zeile 70, VOR der schließenden `}` von `if(profile && session && session.userId)` in Zeile 71, einfügen:

```js
      // Coins-Merge: lokale (anonym gesammelte) Coins dem Server gutschreiben.
      // Nur wenn local > server, sonst Drift bei Tab-Reload.
      let localCoins = 0;
      try { localCoins = parseInt(localStorage.getItem('fmrun_coins') || '0', 10) || 0; } catch(e){}
      const serverCoins = Number(profile.coins_balance || 0);
      let mergedCoins = serverCoins;
      if(localCoins > serverCoins){
        const delta = Math.min(localCoins - serverCoins, 1000000);
        try {
          const { data: newTotal, error } = await sb.rpc('add_coins', {
            p_user_id: session.userId,
            p_delta: delta,
          });
          if(!error && typeof newTotal !== 'undefined'){
            mergedCoins = Number(newTotal);
            profile.coins_balance = mergedCoins;
          } else if(error){
            // Merge fehlgeschlagen: lokal NICHT überschreiben, beim nächsten Login retry.
            console.warn('[ranking] coins merge failed:', error);
            mergedCoins = localCoins;
          }
        } catch(e){
          console.warn('[ranking] coins merge error:', e);
          mergedCoins = localCoins;
        }
      }
      try { localStorage.setItem('fmrun_coins', String(mergedCoins)); } catch(e){}
      window.dispatchEvent(new CustomEvent('fmrun:coinsSynced', { detail: { coins: mergedCoins } }));
```

Das Ergebnis ist ein Block, der direkt nach dem `fmrun:bestSynced`-Dispatch beginnt und vor dem Ende des `if(profile && session && session.userId)`-Blocks endet (vor Zeile 71 `}`).

- [ ] **Step 4.2: Logout-Reset in signOut einfügen**

Zeile 176-181 (`signOut`-Funktion), ändere von:
```js
  function signOut(){
    clearSession();
    session = null; profile = null;
    updateAccountChip(); hideModal();
    toast('Abgemeldet');
  }
```
zu:
```js
  function signOut(){
    clearSession();
    session = null; profile = null;
    // Coins lokal auf 0 zurücksetzen — verhindert Doppel-Cashout bei Account-Switch.
    try { localStorage.setItem('fmrun_coins', '0'); } catch(e){}
    window.dispatchEvent(new CustomEvent('fmrun:coinsSynced', { detail: { coins: 0, reset: true } }));
    updateAccountChip(); hideModal();
    toast('Abgemeldet');
  }
```

- [ ] **Step 4.3: Login-Merge testen — Szenario A (anonyme Coins gutschreiben)**

Vorbereitung in DevTools-Konsole (ausgeloggt):
```js
// Sicherstellen ausgeloggt
localStorage.removeItem('fmrun_session');
location.reload();
```

Nach reload, ausgeloggt:
```js
localStorage.setItem('fmrun_coins', '250');  // anonym gesammelt
```

Server-Wert vorab prüfen (Supabase MCP):
```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST-HANDLE>';"
```
Erwartung: 0 (oder Ausgangswert merken).

Jetzt im UI einloggen mit Test-Account. Nach Login in Konsole:
```js
localStorage.getItem('fmrun_coins')
```
Erwartung: `"250"`.

Server prüfen:
```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST-HANDLE>';"
```
Erwartung: 250.

- [ ] **Step 4.4: Login-Merge testen — Szenario B (Tab-Reload, kein Doppel-Cashout)**

Direkt nach Step 4.3, ohne Logout — Browser-Tab reloaden:
```js
location.reload();
```

`loadProfile` läuft erneut, weil `session` aus localStorage geladen wird. Nach reload:
```js
localStorage.getItem('fmrun_coins')
```
Erwartung: `"250"` (kein +250!).

Server:
```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST-HANDLE>';"
```
Erwartung: 250 (unverändert).

- [ ] **Step 4.5: Logout-Reset testen**

Im UI auf "Abmelden" klicken. Konsole:
```js
localStorage.getItem('fmrun_coins')
```
Erwartung: `"0"`.

- [ ] **Step 4.6: Login-Merge testen — Szenario C (Account-Switch)**

Nach Logout (Step 4.5), neuer Account-Login (zweiter Test-User mit coins_balance = 0 auf Server):
```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST-HANDLE-2>';"
```

Login im UI. Nach Login:
```js
localStorage.getItem('fmrun_coins')
```
Erwartung: `"0"` (Account B hat 0, Account A's 250 wurden beim Logout gewiped).

- [ ] **Step 4.7: Test-Daten zurücksetzen**

```
mcp__supabase__execute_sql with query="UPDATE public.profiles SET coins_balance = 0 WHERE handle = '<TEST-HANDLE>';"
```

- [ ] **Step 4.8: Commit**

```bash
git add ranking.js
git commit -m "feat(ranking): login-merge for anonymous coins + logout-reset

loadProfile credits localStorage coins (anonymous play) to server only
when local > server (delta = local - server, capped at 1M).
On merge failure, local remains untouched — no data loss.
signOut resets fmrun_coins to 0 to prevent double-cashout on account switch."
```

---

## Task 5: index.html — Run-Delta-Tracking + Game-Over-Hook + Event-Listener

**Files:**
- Modify: `index.html:932-934` (coinsTotal init Block — neue Variable hinzu)
- Modify: `index.html:521-527` (bestSynced listener — analoger coinsSynced listener daneben)
- Modify: `index.html:985-993` (reset Function — coinsAtRunStart setzen)
- Modify: `index.html:1311` (Game-Over Handler — submitCoinsDelta Call)

- [ ] **Step 5.1: `coinsAtRunStart` Variable einführen**

Zeile 932-934, ändere von:
```js
  let coinsTotal = 0;
  try { coinsTotal = parseInt(localStorage.getItem('fmrun_coins') || '0', 10) || 0; } catch(e){}
  document.getElementById('coinsValue').textContent = coinsTotal.toLocaleString('de-DE');
```
zu:
```js
  let coinsTotal = 0;
  try { coinsTotal = parseInt(localStorage.getItem('fmrun_coins') || '0', 10) || 0; } catch(e){}
  let coinsAtRunStart = coinsTotal;
  document.getElementById('coinsValue').textContent = coinsTotal.toLocaleString('de-DE');
```

- [ ] **Step 5.2: `fmrun:coinsSynced` Event-Listener hinzufügen**

Zeile 527 (Ende des `fmrun:bestSynced`-Blocks), nach der schließenden `});`, einfügen:

```js
  // Coins werden von ranking.js (Server) synced nach Login + Game-Over.
  // Event 'fmrun:coinsSynced' updated lokale 'coinsTotal' + 'coinsAtRunStart' + Display.
  //   - detail.reset = true (Logout): hart auf den Wert zurücksetzen.
  //   - sonst (Sync nach Game-Over / Login-Merge): nur nach oben shiften, damit
  //     Pickups eines bereits gestarteten neuen Runs nicht verloren gehen,
  //     falls die RPC-Response erst nach Reset() ankommt.
  window.addEventListener('fmrun:coinsSynced', (e) => {
    const detail = (e && e.detail) || {};
    const serverCoins = detail.coins | 0;
    if(detail.reset){
      coinsTotal = serverCoins;
      coinsAtRunStart = serverCoins;
    } else if(serverCoins > coinsTotal){
      const shift = serverCoins - coinsTotal;
      coinsTotal = serverCoins;
      coinsAtRunStart += shift; // Delta des laufenden Runs bleibt erhalten
    }
    const el = document.getElementById('coinsValue');
    if(el) el.textContent = coinsTotal.toLocaleString('de-DE');
  });
```

- [ ] **Step 5.3: `coinsAtRunStart` in `reset()` setzen**

Zeile 993, im `reset()`-Body, ändere von:
```js
    // coinsTotal NICHT zuruecksetzen -- bleibt rundenuebergreifend erhalten
```
zu:
```js
    // coinsTotal NICHT zuruecksetzen -- bleibt rundenuebergreifend erhalten.
    // coinsAtRunStart merkt sich den Startwert, damit Game-Over das Delta kennt.
    coinsAtRunStart = coinsTotal;
```

- [ ] **Step 5.4: Game-Over-Hook erweitern**

Zeile 1311, ändere von:
```js
    try { window.FMRanking && window.FMRanking.submitScore(m); } catch(e){}
```
zu:
```js
    try { window.FMRanking && window.FMRanking.submitScore(m); } catch(e){}
    try {
      const coinsDelta = coinsTotal - coinsAtRunStart;
      coinsAtRunStart = coinsTotal; // Reentry-Schutz: nächster Trigger sieht delta = 0
      if(coinsDelta > 0 && window.FMRanking && window.FMRanking.submitCoinsDelta){
        window.FMRanking.submitCoinsDelta(coinsDelta);
      }
    } catch(e){}
```

- [ ] **Step 5.5: End-to-End-Verifikation im Browser**

Server läuft. Browser auf der App, eingeloggt (Test-User mit `coins_balance = 0`).

Vor dem Run:
```js
localStorage.getItem('fmrun_coins')  // sollte "0" sein
```

Run starten. Coins einsammeln (siehe Spiel-Logik — beim Shizzo-Charakter über Coin-Sprites laufen). Beispiel: 50 Coins sammeln. UI zeigt "50".

Sterben (Game-Over auslösen). Konsole:
```js
localStorage.getItem('fmrun_coins')
```
Erwartung: `"50"` (zumindest 50, je nachdem was tatsächlich gesammelt wurde).

Server prüfen:
```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST-HANDLE>';"
```
Erwartung: 50.

- [ ] **Step 5.6: Multi-Run-Verifikation**

Direkt nach Step 5.5, NICHT reloaden, neuen Run starten.
Beim Reset wird `coinsAtRunStart = 50` gesetzt.

30 weitere Coins sammeln (UI zeigt 80).

Game-Over. Server prüfen:
```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST-HANDLE>';"
```
Erwartung: 80. (Delta = 80 - 50 = 30 wurde geschickt, Server: 50 + 30 = 80.)

- [ ] **Step 5.7: Cross-Device-Sync verifizieren**

Im selben Browser, Logout. Anderes Browser-Profile / Inkognito-Tab öffnen, App laden. Einloggen mit demselben Test-User.

Konsole nach Login:
```js
localStorage.getItem('fmrun_coins')
```
Erwartung: `"80"` (vom Server geladen).

UI-`#coinsValue`-Element checken: zeigt "80".

- [ ] **Step 5.8: Test-Daten zurücksetzen**

```
mcp__supabase__execute_sql with query="UPDATE public.profiles SET coins_balance = 0 WHERE handle = '<TEST-HANDLE>';"
```

```js
localStorage.setItem('fmrun_coins', '0');
```

- [ ] **Step 5.9: Commit**

```bash
git add index.html
git commit -m "feat(game): persist coin delta to server on game-over

- Trackt coinsAtRunStart, gesetzt in reset() pro Run.
- Game-Over schickt (coinsTotal - coinsAtRunStart) an FMRanking.submitCoinsDelta.
- Reentry-Schutz: coinsAtRunStart wird vor RPC-Call gleichgesetzt.
- Listener auf fmrun:coinsSynced updated coinsTotal + UI vom Server-Wert
  (gleicht Drift zwischen Geräten aus)."
```

---

## Task 6: Spec-Verification-Pass (End-to-End)

Geht systematisch die Verification-Checkliste aus dem Spec durch. Alle Tests laufen gegen die deployte Migration + den geänderten Client.

- [ ] **Step 6.1: Migration sichtbar**

```
mcp__supabase__execute_sql with query="\d public.profiles"
```
oder
```
mcp__supabase__list_tables
```
Erwartung: `coins_balance bigint NOT NULL DEFAULT 0` im Profil-Schema.

- [ ] **Step 6.2: Bestehende User unkaputt**

```
mcp__supabase__execute_sql with query="SELECT handle, best_distance, coins_balance FROM public.profiles ORDER BY created_at LIMIT 5;"
```
Erwartung: alle haben `coins_balance = 0`, kein Crash, `best_distance` unverändert.

- [ ] **Step 6.3: Coin-Sync nach Run (Vollzyklus)**

Vor Test: `UPDATE profiles SET coins_balance = 0 WHERE handle = '<TEST>'` und `localStorage.setItem('fmrun_coins', '0')`.

Eingeloggt, Run mit 50 Coins → Game-Over → Server: 50.
Zweiter Run mit 30 → Server: 80.

(Identisch zu Step 5.5/5.6.)

- [ ] **Step 6.4: Login-Merge (anonym → eingeloggt)**

Logout. localStorage `fmrun_coins` auf 200 setzen. Login. Erwartung: Server 200 (von 0), UI 200.
Tab-Reload. Erwartung: Server bleibt 200, UI 200, KEIN Doppel-Cashout.

(Identisch zu Step 4.3/4.4.)

- [ ] **Step 6.5: Logout-Reset**

Nach Login mit 200 Server-Coins, Logout. Erwartung: localStorage `fmrun_coins = 0`, UI `0`.

- [ ] **Step 6.6: Cross-Device**

Zweite Browser-Session, Login mit demselben User. Erwartung: localStorage und UI zeigen den Server-Stand.

- [ ] **Step 6.7: RPC-Validation**

```
mcp__supabase__execute_sql with query="SELECT public.add_coins('<UUID>'::uuid, -1);"
```
Fehler: `invalid_delta`.

```
mcp__supabase__execute_sql with query="SELECT public.add_coins('<UUID>'::uuid, 1000001);"
```
Fehler: `delta_too_large`.

- [ ] **Step 6.8: Concurrent-Updates**

Zwei Tabs gleichzeitig eingeloggt, beide einen Run zu Ende spielen (Delta X und Y).

```
mcp__supabase__execute_sql with query="SELECT coins_balance FROM public.profiles WHERE handle = '<TEST>';"
```
Erwartung: Start + X + Y (Postgres-`UPDATE … + delta` ist atomar).

- [ ] **Step 6.9: Test-Daten finalresetten**

```
mcp__supabase__execute_sql with query="UPDATE public.profiles SET coins_balance = 0 WHERE handle IN ('<TEST>', '<TEST2>');"
```

- [ ] **Step 6.10: Push**

```bash
git push origin main
```
