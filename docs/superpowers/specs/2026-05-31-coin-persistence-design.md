# Spec: Server-persistente Coin-Balance

**Datum:** 2026-05-31
**Status:** Approved — bereit für Implementation Plan
**Scope:** Phase 1 (sammeln only, kein Spending)

## Context

Heute werden Coins client-seitig in `localStorage.fmrun_coins` persistiert. Das funktioniert geräte-lokal, ist aber Gerät-gebunden: Wer auf dem Handy spielt und sich auf dem Desktop einloggt, sieht dort 0 Coins. Coins sollen — analog zum bereits existierenden `best_distance` — pro User-Account in Supabase gespeichert werden, damit sie geräte­übergreifend erhalten bleiben und persistieren, auch wenn der Spieler den Browser-Cache leert.

Phase 1 ist bewusst auf "sammeln" beschränkt. Spending (Items kaufen, Skins, etc.) ist explizit out of scope und kann später als eigenes Feature folgen, ohne dass diese Schema-Erweiterung umgebaut werden muss.

## Architektur-Übersicht

```
┌──────────────┐   pickup (lokal)      ┌─────────────────┐
│  Game-Loop   │ ────────────────────▶ │ coinsTotal +    │
│ (index.html) │                       │ localStorage    │
└──────────────┘                       └─────────────────┘
       │                                        │
       │ game-over: delta = total - atRunStart  │
       ▼                                        │
┌──────────────┐   rpc('add_coins',             │
│  ranking.js  │       userId, delta)           │
│              │ ─────────────────────────────▶ Supabase
│              │   ◀── new server_total ──────  RPC: add_coins
│              │                                │
│              │   sign-in: rpc('authenticate') │
│              │ ◀── {id, handle, best, coins} ─
└──────────────┘                                │
       │                                        │
       │ if localCoins > 0 → add_coins(local)   │
       ▼                                        │
   merged total → localStorage + UI             │
```

**Trust-Modell:** Wie heute bei `submit_score_by_id` — der Client liefert `p_user_id`, RPC läuft als `SECURITY DEFINER`. Anti-Cheat-Niveau bleibt identisch zum bestehenden Distance-Score. Bekannte Limitation, in Phase 1 nicht adressiert.

## Schema-Änderung

Neue Migration `supabase/migrations/0005_coins_balance.sql`:

```sql
ALTER TABLE public.profiles
  ADD COLUMN coins_balance bigint NOT NULL DEFAULT 0
  CHECK (coins_balance >= 0);
```

**Begründung:**
- `bigint` statt `integer`: Headroom, kostet auf einer kleinen Tabelle nichts.
- `NOT NULL DEFAULT 0`: bestehende Profile bekommen automatisch 0, kein Backfill nötig.
- `CHECK (>= 0)`: Safety-Net falls Phase-2-Spending mal Subtraktion einführt.
- Kein Index — wir filtern/sortieren nicht nach Coins (Leaderboard läuft weiter auf `best_distance`).

## RPCs

### `add_coins(p_user_id uuid, p_delta integer) RETURNS bigint`

```sql
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

**Soft-Cap 1.000.000:** ein realistischer Run produziert wenige Hundert Coins, ein Login-Merge mit anonym angesparten Coins typisch wenige Tausend. 1M blockt offensichtliche Manipulation, trifft echte Spieler nicht — auch nicht bei sehr langer Anonym-Sammelphase. Client puffert defensiv auf den Cap, falls je überschritten.

### `authenticate` erweitern

Bestehendes RPC um zwei Felder erweitern, damit Login einen einzigen Round-Trip macht:

```sql
CREATE OR REPLACE FUNCTION public.authenticate(p_handle text, p_password_hash text)
RETURNS TABLE(id uuid, handle text, best_distance integer, coins_balance bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, handle, best_distance, coins_balance
    FROM public.profiles
   WHERE handle = p_handle
     AND password_hash = p_password_hash
   LIMIT 1;
$$;
```

**Hinweis für Implementation:** Bestehende Signatur in `0003_handle_password_auth.sql` / `0004_remove_auth_dependencies.sql` doppelchecken — Felder-Reihenfolge im Return muss zur jeweiligen Definition passen.

## Client-Flow

### Run-Delta tracken (in `index.html`)

```js
let coinsTotal      = parseInt(localStorage.getItem('fmrun_coins') || '0', 10) || 0;
let coinsAtRunStart = coinsTotal;  // NEU
```

Beim Start eines Runs:
```js
coinsAtRunStart = coinsTotal;
```

Pickup-Logik bleibt unverändert (lokales Inkrement + `localStorage.setItem`).

### Game-Over: Delta senden

In `ranking.js` neue exportierte Funktion `submitCoinsDelta(delta)`:

```js
function submitCoinsDelta(delta) {
  if (!session || delta <= 0) return;
  sb.rpc('add_coins', { p_user_id: session.userId, p_delta: delta })
    .then(({ data, error }) => {
      if (error) { console.warn('coins sync failed:', error); return; }
      const newTotal = Number(data);
      localStorage.setItem('fmrun_coins', String(newTotal));
      // UI + globale coinsTotal aktualisieren — via Custom-Event,
      // analog zu fmrun:bestSynced.
      document.dispatchEvent(new CustomEvent('fmrun:coinsSynced', { detail: newTotal }));
    });
}
```

Im Game-Over-Handler in `index.html` (gleiche Stelle, an der heute der Distance-Submit getriggert wird):

```js
const delta = coinsTotal - coinsAtRunStart;
coinsAtRunStart = coinsTotal;  // Reentry-Schutz: zweiter Trigger sieht delta = 0.
submitCoinsDelta(delta);
```

`index.html` lauscht zusätzlich auf `fmrun:coinsSynced` und updated `coinsTotal`, `coinsAtRunStart` sowie das UI-Element `#coinsValue` (Server-Wert ist nach Round-Trip die Wahrheit — gleicht Drift zwischen Geräten aus).

### Login: Server-Total + Merge

Im `signIn`-Handler in `ranking.js`, nach erfolgreichem `authenticate`-Call:

```js
const serverCoins = Number(data[0].coins_balance || 0);
const localCoins  = parseInt(localStorage.getItem('fmrun_coins') || '0', 10) || 0;
const COIN_CAP    = 1000000;

let merged = serverCoins;
if (localCoins > 0) {
  // Lokale Coins (anonym gesammelt oder von Vor-Login-Session) gutschreiben.
  // Client-Cap, falls localCoins absurd hoch ist — verhindert delta_too_large.
  const delta = Math.min(localCoins, COIN_CAP);
  const { data: d, error } = await sb.rpc('add_coins', {
    p_user_id: data[0].id,
    p_delta:   delta,
  });
  if (!error) {
    merged = Number(d);
  } else {
    // Merge fehlgeschlagen: lokal NICHT überschreiben.
    // Nächster Login-Versuch macht denselben Pfad noch mal.
    console.warn('coins merge failed:', error);
    return;
  }
}

localStorage.setItem('fmrun_coins', String(merged));
document.dispatchEvent(new CustomEvent('fmrun:coinsSynced', { detail: merged }));
```

**Failure-Verhalten:** Wenn der Merge-RPC fehlschlägt (Netzwerk, Cap, etc.), bleibt der lokale Stand unberührt — kein Datenverlust. Beim nächsten Login wird derselbe Pfad erneut versucht.

### Logout: lokal zurücksetzen

Im Sign-out-Handler:
```js
localStorage.setItem('fmrun_coins', '0');
document.dispatchEvent(new CustomEvent('fmrun:coinsSynced', { detail: 0 }));
```

Verhindert Doppel-Gutschrift bei Account-Switch und macht das Verhalten vorhersehbar (selbe Semantik wie `fmrun_best` heute).

### Anonymes Spiel

Keine Session → kein RPC. Pickups bleiben rein lokal. Beim ersten Login werden die lokal angesparten Coins via Merge-Pfad gutgeschrieben.

## Edge-Cases & Failure-Modes

| Szenario | Verhalten | Tradeoff |
|---|---|---|
| Network-Error beim Game-Over-Sync | Lokal korrekt, Server-Delta verloren. Nächster Run sync't nur das *neue* Delta. | YAGNI: keine Outbox/Retry. Akzeptiert. |
| Doppelter Game-Over-Trigger | `coinsAtRunStart = coinsTotal` direkt nach RPC → zweiter Aufruf hat `delta = 0`. | — |
| Tab schließen mid-run | Pickups lokal persistiert. Game-Over-Sync läuft nicht → Delta verloren bis nächstem Run. | YAGNI: kein `beforeunload`/`sendBeacon`. |
| Account-Switch | Logout-Reset auf 0 → Account B startet sauber, kein Doppel-Cashout. | — |
| Concurrent Devices | `UPDATE … + delta` atomar in Postgres, beide Deltas landen korrekt. | — |
| Live-Migration | Additiv: `ADD COLUMN DEFAULT 0` instant, `CREATE OR REPLACE FUNCTION` zerstört alte Clients nicht (alte Felder bleiben in Return). Migration zuerst, Client danach. | — |
| Browser ohne `localStorage` | Try/catch wie heute → Spiel läuft, Coins ephemer. | — |

## Out of Scope

- **Spending:** keine Subtraktion, keine kaufbaren Items, keine Lives-für-Coins-Mechanik.
- **Coins-Leaderboard:** Leaderboard läuft weiter auf `best_distance`. Falls später eine Coins-Rangliste gewünscht: separater Index + RPC.
- **Audit-Trail (`coin_transactions`-Tabelle):** abgelehnt als YAGNI. Falls Cheating Problem wird, später nachrüstbar.
- **Offline-Outbox / Retry-Queue:** verlorene Deltas bei Network-Error werden akzeptiert.
- **Server-Side Anti-Cheat:** Trust-Modell bleibt identisch zu `best_distance`. Bekannte Limitation.

## Verification

Nach Implementation prüfen:

1. **Migration**: `supabase migration list` zeigt 0005, `\d profiles` zeigt `coins_balance bigint NOT NULL DEFAULT 0`.
2. **Neue User**: Registrierung → `coins_balance = 0` in DB.
3. **Bestehende User**: nach Migration → `coins_balance = 0`, kein Crash bei Login.
4. **Coin-Sync nach Run**:
   - Eingeloggt, lokal 0, Run mit 50 Coins → Game-Over → DB zeigt 50.
   - Zweiter Run mit 30 Coins → DB zeigt 80.
5. **Login-Merge**:
   - Anonym 200 Coins sammeln → Login → DB ging von 0 auf 200, UI zeigt 200.
   - Logout (UI 0) → erneut einloggen → UI zeigt 200 (kein Doppel-Cashout, weil lokal 0).
6. **Cross-Device**: Auf Handy 100 sammeln + game-over, dann auf Desktop einloggen → Desktop zeigt 100.
7. **RPC-Validierung**: `sb.rpc('add_coins', {p_user_id, p_delta: -1})` → wirft `invalid_delta`. `p_delta: 1000001` → wirft `delta_too_large`.
8. **Concurrent**: zwei Browser-Tabs als selber User, beide game-over mit Deltas X und Y → DB-Endstand = start + X + Y.
