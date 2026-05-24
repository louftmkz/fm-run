# FM RUN — Ranking-System (Spec)

**Datum:** 2026-05-24
**Status:** Design abgesegnet, bereit für Implementierungsplan
**Ansatz:** Pure Client-Side + Supabase, abgesichert per Row-Level-Security (RLS)

## Ziel

Ein Ranking-System für das Endless-Runner-Spiel FM RUN. User können sich per
E-Mail anmelden, einen eindeutigen Handle vergeben, Freundschaftsanfragen per
Handle verschicken (die der andere annehmen muss) und ihren besten Lauf in zwei
Ranglisten vergleichen: **Freunde** und **Weltweit**.

## Entscheidungen (vom User bestätigt)

| Thema | Entscheidung |
|---|---|
| Login | E-Mail-OTP (6-stelliger Code, passwortlos) |
| Ranking-Wert | Beste Distanz in Metern (`best_distance`) — ein Leaderboard |
| Account-Pflicht | Optional — anonymes Spielen möglich, Account nur für Ranking & Freunde |
| Cheat-Schutz v1 | Client vertrauen; RLS begrenzt auf eigene Zeile, `greatest()` erzwingt monotonen Rekord |
| Score-Migration | Lokaler `fmrun_best` wird beim ersten Login als Start-Score übernommen |
| Handle | Änderbar, muss eindeutig bleiben (case-insensitiv) |

## Kontext

- Single-File-Spiel `index.html` (Vanilla JS, kein Build), deployed auf Vercel.
- Score = `distance` in Metern; aktuell lokal in `localStorage` (`fmrun_best`, `fmrun_coins`).
- PWA mit `service-worker.js`: cache-first für statische Assets, network-first für HTML.
  Der SW ignoriert bereits Cross-Origin- und Nicht-GET-Requests
  (`url.origin !== self.location.origin`, `req.method !== 'GET'`) → Supabase-API-Calls
  laufen ungehindert durch.

## Architektur

`index.html` spricht direkt mit Supabase über das JS-SDK. Es gibt **keinen
eigenen Server-Code**. Die gesamte Sicherheit liegt in Row-Level-Security plus
einer Handvoll SQL-Funktionen (RPC). Das passt zur „static, kein Build"-Natur
des Projekts und zum Supabase-Free-Tier.

Das `supabase-js`-SDK wird **lokal ins Repo gebündelt** (`./vendor/supabase.min.js`)
und in den `PRECACHE` aufgenommen, damit die PWA offline lauffähig bleibt. Alle
Ranking-Calls sind defensiv gekapselt: Ein fehlgeschlagener SDK-Load oder
Netzwerkfehler darf das Spiel selbst niemals blockieren.

## Datenmodell

### Tabelle `profiles` (eine Zeile pro User)

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | uuid PK | `references auth.users(id) on delete cascade` |
| `handle` | text NOT NULL | Format `^[A-Za-z0-9_]{3,20}$`; Unique-Index auf `lower(handle)` (case-insensitiv eindeutig) |
| `best_distance` | integer NOT NULL DEFAULT 0 | `check (best_distance >= 0)` |
| `created_at` | timestamptz DEFAULT now() | |
| `updated_at` | timestamptz DEFAULT now() | per Trigger aktualisiert |

E-Mail wird von Supabase in `auth.users` verwaltet und liegt **nicht** in
`profiles`. Auf der Worldwide-Liste sind damit nur `handle` + `best_distance`
sichtbar, niemals die E-Mail-Adresse.

### Tabelle `friendships` (eine Zeile pro Beziehung)

| Spalte | Typ | Constraints |
|---|---|---|
| `id` | uuid PK DEFAULT gen_random_uuid() | |
| `requester_id` | uuid NOT NULL | `references profiles(id) on delete cascade` |
| `addressee_id` | uuid NOT NULL | `references profiles(id) on delete cascade` |
| `status` | text NOT NULL DEFAULT 'pending' | `check (status in ('pending','accepted'))` |
| `created_at` | timestamptz DEFAULT now() | |
| `updated_at` | timestamptz DEFAULT now() | |

Zusätzliche Constraints:
- `check (requester_id <> addressee_id)` — keine Selbst-Freundschaft.
- Unique-Index auf `(least(requester_id, addressee_id), greatest(requester_id, addressee_id))`
  — verhindert doppelte Beziehung in beide Richtungen (A→B und B→A).

## Sicherheit (RLS-Policies)

RLS ist auf beiden Tabellen aktiviert.

### `profiles`
- **SELECT:** `using (true)` — öffentliche Rangliste; exponiert nur Handle + Distanz.
  Erlaubt auch anonymen Spielern, die Worldwide-Liste zu sehen.
- **INSERT:** `with check (id = auth.uid())` — User legt nur die eigene Zeile an.
- **UPDATE:** `using (id = auth.uid()) with check (id = auth.uid())` — nur eigene Zeile
  (Handle ändern; Score läuft über `submit_score`).
- **DELETE:** keine Policy (Löschung erfolgt per Cascade beim Löschen des Auth-Users).

### `friendships`
- **SELECT:** `using (auth.uid() = requester_id OR auth.uid() = addressee_id)` —
  man sieht nur Beziehungen, in denen man selbst vorkommt.
- **INSERT:** `with check (auth.uid() = requester_id AND status = 'pending')` —
  man verschickt Anfragen nur als man selbst.
- **UPDATE:** `using (auth.uid() = addressee_id) with check (status = 'accepted')` —
  nur der Empfänger kann annehmen.
- **DELETE:** `using (auth.uid() = requester_id OR auth.uid() = addressee_id)` —
  beide Seiten können zurückziehen / ablehnen / entfreunden.

## SQL-Funktionen (RPC)

Alle als `SECURITY INVOKER` (Default) — RLS greift, kein erhöhtes Recht nötig.

- **`submit_score(p_distance int) returns int`**
  `update profiles set best_distance = greatest(best_distance, p_distance),
  updated_at = now() where id = auth.uid(); return new best_distance.`
  Einziger Schreibpfad für den Score; erzwingt monoton steigenden Rekord.

- **`friends_leaderboard() returns table(handle text, best_distance int, is_me boolean)`**
  Ich + alle akzeptierten Freunde, sortiert nach `best_distance` absteigend.

- **`my_worldwide_rank() returns int`**
  `1 + count(profiles where best_distance > eigene)`.

## Client-Flows

1. **Boot:** `createClient(url, anonKey)` → `getSession()`. Bei Session: Profil
   laden, Handle in der UI anzeigen.
2. **Login:** „Anmelden" → E-Mail eingeben → `signInWithOtp({ email })` →
   6-stelligen Code eingeben → `verifyOtp({ email, token, type: 'email' })`.
3. **Erstes Mal (kein Profil):** Handle abfragen → `insert into profiles
   (id = auth.uid(), handle)`. Bei Unique-Konflikt erneut fragen. Danach
   `submit_score(fmrun_best aus localStorage)` (Migration).
4. **Game Over (eingeloggt):** `submit_score(Math.floor(distance))` →
   „Dein Rang: #X" via `my_worldwide_rank()` anzeigen.
5. **Rangliste öffnen:** Tab **Freunde** → `friends_leaderboard()`;
   Tab **Weltweit** → Top 100 (`select handle, best_distance from profiles
   order by best_distance desc limit 100`) + eigener Rang.
6. **Freunde:**
   - Hinzufügen: Handle → Profil-Lookup → `insert friendship(requester = ich,
     addressee = gefunden, pending)`.
   - Eingehende Anfragen: `friendships` wo `addressee = ich, status = pending`,
     mit Requester-Handle gejoint → Annehmen (`update status='accepted'`) /
     Ablehnen (`delete`).
   - Ausgehende Anfragen sichtbar; Entfreunden (`delete`).

## UI (bestehender Pixel-Look: Press Start 2P, Gelb-Akzent, dunkle Modals)

- **Start-Screen:** kleiner Account-Chip oben rechts (Login-Status bzw. Handle)
  + Button **„Rangliste"**.
- **Auth-Modal:** Schritte E-Mail → Code → Handle.
- **Rangliste-Modal:** zwei Tabs *Freunde | Weltweit*, Zeilen Rang/Handle/Distanz,
  eigene Zeile hervorgehoben.
- **Freunde-Bereich:** Eingabefeld „Handle hinzufügen", Liste eingehender Anfragen
  (Annehmen/Ablehnen), Freundesliste (Entfreunden).
- **Game Over:** „Dein Rang: #X" wenn eingeloggt.

## Offline / Secrets / Konfiguration

- `supabase-js` lokal nach `./vendor/supabase.min.js` + in `PRECACHE`,
  `CACHE_NAME` bumpen → Spiel bleibt offline lauffähig.
- **Secrets:** `SUPABASE_URL` + **anon key** inline in `index.html`. Der anon key
  ist öffentlich by design; RLS ist die Sicherheitsgrenze. Der `service_role`-Key
  kommt **niemals** in den Client.
- **Setup-Abhängigkeit:** FREE-Supabase-Projekt anlegen, SQL-Migration einspielen,
  Email-Auth (OTP) aktivieren, `URL` + `anon key` in `index.html` eintragen.
  Zwei Wege: (a) Projekt + Migrationen über den Supabase-MCP anlegen, oder
  (b) User erstellt das Projekt im Dashboard und liefert die zwei Werte.

## Bekannte Grenzen (v1, akzeptiert)

- **Cheat-Schutz:** Client kann theoretisch beliebige Distanz an `submit_score`
  schicken. RLS begrenzt auf die eigene Zeile, `greatest()` verhindert Absenken.
  Server-seitige Plausibilitätsprüfung per Edge Function später nachrüstbar
  (die RPCs sind der Austauschpunkt).
- **Free-Tier-Pause:** Projekt pausiert nach ~7 Tagen Inaktivität; der erste
  Request weckt es ggf. mit Verzögerung. Für einen Hobby-Launch akzeptabel.

## Edge Cases

- Handle bereits vergeben → erneut fragen.
- Anfrage an nicht-existenten Handle → freundliche Fehlermeldung.
- Anfrage an jemanden, der mir bereits eine geschickt hat → automatisch annehmen.
- Selbst-Anfrage → durch `requester <> addressee` blockiert.
- Doppelte Anfrage → durch Unique-Index verhindert; UI zeigt „bereits angefragt/befreundet".
- Falscher/abgelaufener OTP-Code → Fehlermeldung, erneuter Versuch möglich.
- Logout → UI zurücksetzen, anonymes Weiterspielen bleibt möglich.

## Testing

- **Manuell:** Zwei Accounts (zwei E-Mails / Inkognito), kompletter
  Freundschafts-Handshake + beide Ranglisten.
- **RLS-Verifikation:** Bestätigen, dass man fremde `friendships` nicht lesen und
  fremde `profiles` nicht ändern kann (kurze SQL-/Policy-Checks).
