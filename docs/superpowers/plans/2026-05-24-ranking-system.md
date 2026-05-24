# Ranking-System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email-OTP-Login + eindeutige Handles + Freundschaftsanfragen (mit Annahme) + zwei Ranglisten (Freunde / Weltweit) für FM RUN, komplett über Supabase.

**Architecture:** Pure Client-Side. `index.html` spricht direkt mit Supabase über das gebündelte JS-SDK. Sämtliche Sicherheit liegt in Row-Level-Security + drei SQL-Funktionen. Kein eigener Server-Code. Ranking-Logik in separater `ranking.js`, defensiv gekapselt — Spiel bleibt voll funktionsfähig, auch wenn Supabase nicht erreichbar ist.

**Tech Stack:** Supabase (Postgres + Auth + RLS), `@supabase/supabase-js` v2 (lokal vendored), Vanilla JS, kein Build.

**Spec:** `docs/superpowers/specs/2026-05-24-ranking-system-design.md`

**Testing-Realität:** Kein Test-Runner im Projekt. Verifikation erfolgt über (a) Supabase-MCP `execute_sql` für Schema/Policy/Funktions-Checks und (b) Browser-Smoke-Tests via `/browse` gegen einen lokalen Static-Server. Funktionale RLS-Prüfung (zwei Accounts) im Schluss-Task manuell.

---

## File Structure

| Datei | Verantwortung | Aktion |
|---|---|---|
| `supabase/migrations/0001_ranking.sql` | Schema, RLS-Policies, RPC-Funktionen | Create |
| `vendor/supabase.min.js` | Gebündeltes supabase-js v2 (UMD), offline-fähig | Create |
| `ranking.js` | Gesamte Client-Ranking-Logik + UI-Wiring; exponiert `window.FMRanking` | Create |
| `index.html` | Config-Block, Script-Tags, Modal-Markup, Account-Chip + Rangliste-Button, `#overRank`, ein `submitScore`-Aufruf in `gameOver()`, Modal-CSS | Modify |
| `service-worker.js` | `vendor/supabase.min.js` + `ranking.js` in `PRECACHE`, `CACHE_NAME` bumpen | Modify |

**Integrations-Schnittstelle Spiel ↔ Ranking (minimal-invasiv):**
- Spiel ruft in `gameOver()` genau eine Zeile auf: `try{ window.FMRanking && window.FMRanking.submitScore(m); }catch(e){}`.
- `ranking.js` schreibt den Rang selbstständig in `#overRank` und verwaltet alle eigenen Buttons/Modals. Es liest **keine** privaten Spielvariablen.

---

## Task 1: Supabase-Projekt + Migration (Schema, RLS, RPC)

**Files:**
- Create: `supabase/migrations/0001_ranking.sql`

**Voraussetzung — Projekt-Erstellung (eine der beiden Optionen, vor Ausführung mit User klären):**
- **(a) MCP-Weg:** `mcp__supabase__list_organizations` → `mcp__supabase__get_cost`/`confirm_cost` → `mcp__supabase__create_project` (FREE/`nano`), Region nah an DE (z.B. `eu-central-1`). Danach `mcp__supabase__get_project_url` + `mcp__supabase__get_publishable_keys` (anon key).
- **(b) Dashboard-Weg:** User legt FREE-Projekt an, aktiviert Email-Auth, liefert `Project URL` + `anon public key`.
- **Email-OTP aktivieren:** Auth → Providers → Email → „Confirm email" so konfigurieren, dass OTP-Codes verschickt werden (Supabase sendet bei `signInWithOtp` standardmäßig einen 6-stelligen Code, sofern das Email-Template `{{ .Token }}` enthält). Default-Template prüfen/auf Token umstellen.

- [ ] **Step 1: Migration-Datei schreiben**

Create `supabase/migrations/0001_ranking.sql`:

```sql
-- FM RUN Ranking-System: Schema, RLS, RPC
-- Anwendbar via Supabase Dashboard (SQL Editor) oder MCP apply_migration.

-- ---------- 1. Tabelle profiles ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text not null,
  best_distance integer not null default 0 check (best_distance >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint handle_format check (handle ~ '^[A-Za-z0-9_]{3,20}$')
);

-- Handle case-insensitiv eindeutig
create unique index if not exists profiles_handle_lower_idx
  on public.profiles (lower(handle));

-- ---------- 2. Tabelle friendships ----------
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint no_self_friend check (requester_id <> addressee_id)
);

-- Verhindert doppelte Beziehung in beide Richtungen (A->B und B->A)
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- ---------- 3. updated_at Trigger ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists friendships_touch on public.friendships;
create trigger friendships_touch before update on public.friendships
  for each row execute function public.touch_updated_at();

-- ---------- 4. RLS ----------
alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;

-- profiles: öffentliche Leseliste (nur handle + best_distance), Schreiben nur eigene Zeile
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- friendships: nur eigene Beziehungen sichtbar; senden als requester; annehmen nur addressee
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert with check (auth.uid() = requester_id and status = 'pending');

drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update using (auth.uid() = addressee_id) with check (status = 'accepted');

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ---------- 5. RPC-Funktionen ----------
-- Einziger Schreibpfad für den Score; erzwingt monoton steigenden Rekord.
create or replace function public.submit_score(p_distance integer)
returns integer language sql security invoker as $$
  update public.profiles
     set best_distance = greatest(best_distance, p_distance)
   where id = auth.uid()
  returning best_distance;
$$;

-- Ich + akzeptierte Freunde, sortiert nach Distanz absteigend.
create or replace function public.friends_leaderboard()
returns table(handle text, best_distance integer, is_me boolean)
language sql security invoker stable as $$
  select p.handle, p.best_distance, (p.id = auth.uid()) as is_me
    from public.profiles p
   where p.id = auth.uid()
      or p.id in (
        select case when f.requester_id = auth.uid() then f.addressee_id
                    else f.requester_id end
          from public.friendships f
         where f.status = 'accepted'
           and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
      )
   order by p.best_distance desc, p.handle asc;
$$;

-- 1 + Anzahl Profile mit höherer Distanz als die eigene.
create or replace function public.my_worldwide_rank()
returns integer language sql security invoker stable as $$
  select 1 + count(*)::int
    from public.profiles p
   where p.best_distance > coalesce(
           (select best_distance from public.profiles where id = auth.uid()), -1);
$$;
```

- [ ] **Step 2: Migration anwenden**

MCP-Weg: `mcp__supabase__apply_migration` mit `name: "0001_ranking"` und obigem SQL.
Dashboard-Weg: SQL Editor → Inhalt einfügen → Run.

- [ ] **Step 3: Schema-/Policy-/Funktions-Existenz verifizieren**

Run via `mcp__supabase__execute_sql`:

```sql
select table_name from information_schema.tables
 where table_schema='public' and table_name in ('profiles','friendships');
select policyname, cmd from pg_policies
 where schemaname='public' order by tablename, policyname;
select proname from pg_proc
 where pronamespace='public'::regnamespace
   and proname in ('submit_score','friends_leaderboard','my_worldwide_rank');
select indexname from pg_indexes
 where schemaname='public'
   and indexname in ('profiles_handle_lower_idx','friendships_pair_idx');
```

Expected: 2 Tabellen; 7 Policies (3 profiles + 4 friendships); 3 Funktionen; 2 Indizes. RLS aktiv prüfen:

```sql
select relname, relrowsecurity from pg_class
 where relname in ('profiles','friendships');
```
Expected: beide `relrowsecurity = true`.

- [ ] **Step 4: Constraints funktional prüfen (Service-Role, RLS umgangen)**

```sql
-- Handle-Format muss greifen:
do $$ begin
  begin
    insert into public.profiles (id, handle) values (gen_random_uuid(), 'a!');  -- ungültig
    raise exception 'handle_format constraint hat NICHT gegriffen';
  exception when check_violation then null; end;
end $$;
select 'handle_format ok' as check;
```
Expected: Zeile `handle_format ok` (kein Fehler).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_ranking.sql
git commit -m "feat(db): Ranking-Schema + RLS + RPC (profiles, friendships)"
```

---

## Task 2: SDK vendoren, Config, Boot/Session, Account-Chip

**Files:**
- Create: `vendor/supabase.min.js`
- Create: `ranking.js`
- Modify: `index.html` (Config-Block, Script-Tags, Start-Screen-UI, Modal-Grundgerüst + CSS)

- [ ] **Step 1: supabase-js lokal vendoren**

Run:
```bash
mkdir -p vendor
curl -fsSL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js -o vendor/supabase.min.js
test -s vendor/supabase.min.js && echo "vendor ok ($(wc -c < vendor/supabase.min.js) bytes)"
```
Expected: `vendor ok (...)` mit > 100000 bytes. Die UMD-Variante exponiert `window.supabase` mit `createClient`.

- [ ] **Step 2: Config-Block + Script-Tags in `index.html`**

In `index.html` direkt vor dem schließenden `</body>` (nach dem bestehenden Spiel-`<script>`-Block) einfügen:

```html
<!-- ===== Ranking (Supabase) ===== -->
<script>
  // Nach Projekt-Erstellung ausfüllen. anon key ist öffentlich (RLS ist die Sicherheitsgrenze).
  window.FMRUN_SUPABASE = {
    url: 'REPLACE_WITH_PROJECT_URL',
    anonKey: 'REPLACE_WITH_ANON_KEY'
  };
</script>
<script src="./vendor/supabase.min.js"></script>
<script src="./ranking.js" defer></script>
```

> Hinweis: `url`/`anonKey` sind echte Config-Werte, die nach Task 1 eingetragen werden — kein Plan-Platzhalter. Solange sie `REPLACE_...` sind, deaktiviert sich `ranking.js` sauber (siehe `cfgOk()`).

- [ ] **Step 3: Account-Chip + Rangliste-Button im Start-Screen (`index.html`)**

Im `#screenStart`-Block (aktuell Zeilen ~91–96) nach dem „Spielen"-Button und vor `.hint` einfügen:

```html
        <button class="btn btn-secondary" id="btnBoard" type="button">🏆 Rangliste</button>
        <div class="account" id="accountChip">
          <span id="accountStatus">Nicht angemeldet</span>
          <button class="linkbtn" id="btnAuth" type="button">Anmelden</button>
          <button class="linkbtn hidden" id="btnSignOut" type="button">Abmelden</button>
        </div>
```

- [ ] **Step 4: `#overRank` im Game-Over-Screen (`index.html`)**

Im `#screenOver`-Block nach `<p class="sub" id="overText">` und vor dem „Nochmal"-Button einfügen:

```html
        <div class="hint" id="overRank"></div>
```

- [ ] **Step 5: Modal-Grundgerüst (`index.html`)**

Direkt nach `<div id="wrap">…</div>` (vor dem ersten `<script>`) einfügen:

```html
<div class="fmmodal hidden" id="fmModal">
  <div class="fmmodal-panel">
    <button class="fmmodal-close" id="fmModalClose" type="button" aria-label="Schließen">✕</button>

    <!-- View: E-Mail -->
    <div class="fmview" data-view="auth-email">
      <h2>Anmelden</h2>
      <p class="fmnote">Wir schicken dir einen 6-stelligen Code per E-Mail.</p>
      <input class="fminput" id="authEmail" type="email" inputmode="email" autocomplete="email" placeholder="email@beispiel.de">
      <button class="btn" id="btnSendCode" type="button">Code senden</button>
      <div class="fmerr" id="authEmailErr"></div>
    </div>

    <!-- View: Code -->
    <div class="fmview hidden" data-view="auth-code">
      <h2>Code eingeben</h2>
      <p class="fmnote" id="authCodeNote">Code aus der E-Mail eingeben.</p>
      <input class="fminput" id="authCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
      <button class="btn" id="btnVerifyCode" type="button">Bestätigen</button>
      <button class="linkbtn" id="btnResendCode" type="button">Code erneut senden</button>
      <div class="fmerr" id="authCodeErr"></div>
    </div>

    <!-- View: Handle -->
    <div class="fmview hidden" data-view="auth-handle">
      <h2>Handle wählen</h2>
      <p class="fmnote">3–20 Zeichen: Buchstaben, Zahlen, _</p>
      <input class="fminput" id="authHandle" type="text" maxlength="20" placeholder="dein_handle">
      <button class="btn" id="btnSaveHandle" type="button">Speichern</button>
      <div class="fmerr" id="authHandleErr"></div>
    </div>

    <!-- View: Rangliste -->
    <div class="fmview hidden" data-view="board">
      <h2>Rangliste</h2>
      <div class="fmtabs">
        <button class="fmtab active" id="tabFriends" type="button">Freunde</button>
        <button class="fmtab" id="tabWorld" type="button">Weltweit</button>
      </div>
      <div class="fmlist" id="boardList"></div>
      <button class="btn btn-secondary" id="btnFriends" type="button">Freunde verwalten</button>
    </div>

    <!-- View: Freunde -->
    <div class="fmview hidden" data-view="friends">
      <h2>Freunde</h2>
      <div class="fmrow">
        <input class="fminput" id="friendHandle" type="text" maxlength="20" placeholder="Handle hinzufügen">
        <button class="btn" id="btnAddFriend" type="button">+</button>
      </div>
      <div class="fmerr" id="friendErr"></div>
      <h3 class="fmsub">Anfragen</h3>
      <div class="fmlist" id="requestList"></div>
      <h3 class="fmsub">Deine Freunde</h3>
      <div class="fmlist" id="friendList"></div>
      <button class="linkbtn" id="btnBackBoard" type="button">← Zurück zur Rangliste</button>
    </div>
  </div>
</div>
```

- [ ] **Step 6: Modal-CSS (`index.html`)**

Im `<style>`-Block vor `</style>` (nach `.badge`-Regel, ~Zeile 69) einfügen:

```css
  /* ===== Ranking UI ===== */
  .btn-secondary{background:transparent;color:var(--accent);box-shadow:none;border:2px solid var(--accent);margin-top:12px}
  .account{margin-top:18px;font-size:13px;color:var(--ink-dim);display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap}
  .linkbtn{pointer-events:auto;background:none;border:0;color:var(--accent);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;padding:0}
  .fmmodal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);padding:18px;pointer-events:auto}
  .fmmodal-panel{position:relative;width:100%;max-width:380px;max-height:88vh;overflow-y:auto;background:var(--bg-0,#15151b);border:2px solid var(--accent);border-radius:14px;padding:24px 20px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
  .fmmodal-close{position:absolute;top:10px;right:12px;background:none;border:0;color:var(--ink-dim);font-size:20px;cursor:pointer}
  .fmview h2{font-family:'Press Start 2P',system-ui,sans-serif;font-size:15px;color:var(--accent);margin:0 0 14px;letter-spacing:1px}
  .fmsub{font-family:'Press Start 2P',system-ui,sans-serif;font-size:10px;color:var(--ink-dim);margin:18px 0 8px;letter-spacing:1px}
  .fmnote{color:var(--ink-dim);font-size:13px;margin:0 0 12px}
  .fminput{width:100%;box-sizing:border-box;padding:12px 14px;margin:0 0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:var(--ink,#fff);font-size:16px}
  .fminput:focus{outline:none;border-color:var(--accent)}
  .fmerr{color:var(--danger,#ff5566);font-size:13px;min-height:18px;margin-top:6px}
  .fmrow{display:flex;gap:8px;align-items:flex-start}
  .fmrow .fminput{flex:1}
  .fmrow .btn{padding:12px 18px}
  .fmtabs{display:flex;gap:8px;margin-bottom:12px}
  .fmtab{flex:1;pointer-events:auto;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:transparent;color:var(--ink-dim);font:inherit;font-weight:700;cursor:pointer}
  .fmtab.active{border-color:var(--accent);color:var(--accent);background:rgba(255,204,51,.08)}
  .fmlist{display:flex;flex-direction:column;gap:6px;min-height:24px}
  .fmlist-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;background:rgba(255,255,255,.05);font-size:14px}
  .fmlist-row.me{background:rgba(255,204,51,.14);border:1px solid rgba(255,204,51,.4)}
  .fmlist-row .rank{width:34px;color:var(--ink-dim);font-variant-numeric:tabular-nums}
  .fmlist-row .who{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fmlist-row .dist{font-variant-numeric:tabular-nums;color:var(--accent)}
  .fmlist-row .act{display:flex;gap:6px}
  .fmlist-empty{color:var(--ink-dim);font-size:13px;padding:8px 2px}
  .fmminibtn{pointer-events:auto;border:0;border-radius:7px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer}
  .fmminibtn.ok{background:var(--accent);color:#1a1a1a}
  .fmminibtn.no{background:rgba(255,255,255,.1);color:var(--ink-dim)}
  .fmtoast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;background:#222;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;border:1px solid var(--accent);opacity:0;transition:opacity .2s;pointer-events:none}
  .fmtoast.show{opacity:1}
```

- [ ] **Step 7: `ranking.js` Grundgerüst (Boot, Session, Account-Chip, Modal-Helpers)**

Create `ranking.js`:

```javascript
// FM RUN — Ranking-Client (Supabase). Defensiv: jeder Fehler bleibt lokal,
// das Spiel selbst läuft immer weiter.
(() => {
  'use strict';

  const cfg = window.FMRUN_SUPABASE || {};
  let sb = null;        // Supabase-Client
  let session = null;   // aktuelle Auth-Session
  let profile = null;   // { id, handle, best_distance }
  let pendingEmail = ''; // E-Mail während OTP-Flow
  let boardTab = 'friends';

  const $ = (id) => document.getElementById(id);

  function cfgOk(){
    return cfg.url && cfg.anonKey
      && !String(cfg.url).startsWith('REPLACE')
      && !String(cfg.anonKey).startsWith('REPLACE')
      && window.supabase && window.supabase.createClient;
  }

  // ---------- Modal-Helpers ----------
  function showModal(view){ $('fmModal').classList.remove('hidden'); showView(view); }
  function hideModal(){ $('fmModal').classList.add('hidden'); }
  function showView(view){
    document.querySelectorAll('#fmModal .fmview').forEach(v => {
      v.classList.toggle('hidden', v.dataset.view !== view);
    });
    document.querySelectorAll('#fmModal .fmerr').forEach(e => e.textContent = '');
  }
  let toastT = null;
  function toast(msg){
    let t = $('fmToast');
    if(!t){ t = document.createElement('div'); t.id='fmToast'; t.className='fmtoast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Account-Chip ----------
  function updateAccountChip(){
    const status = $('accountStatus'), authBtn = $('btnAuth'), outBtn = $('btnSignOut');
    if(!status) return;
    if(profile){
      status.textContent = '@' + profile.handle;
      authBtn.classList.add('hidden');
      outBtn.classList.remove('hidden');
    } else if(session){
      status.textContent = 'Angemeldet (kein Handle)';
      authBtn.classList.remove('hidden'); authBtn.textContent = 'Handle wählen';
      outBtn.classList.remove('hidden');
    } else {
      status.textContent = 'Nicht angemeldet';
      authBtn.classList.remove('hidden'); authBtn.textContent = 'Anmelden';
      outBtn.classList.add('hidden');
    }
  }

  // ---------- Profil laden ----------
  async function loadProfile(){
    profile = null;
    if(!session) return;
    const { data, error } = await sb.from('profiles')
      .select('id, handle, best_distance').eq('id', session.user.id).maybeSingle();
    if(!error && data) profile = data;
    // Lokalen Highscore migrieren (greatest() ist idempotent)
    if(profile){
      let localBest = 0;
      try { localBest = parseInt(localStorage.getItem('fmrun_best') || '0', 10) || 0; } catch(e){}
      if(localBest > 0){ try { await sb.rpc('submit_score', { p_distance: localBest }); } catch(e){} }
    }
  }

  // ---------- Boot ----------
  async function init(){
    if(!cfgOk()){ console.info('[ranking] Supabase nicht konfiguriert — Ranking deaktiviert.'); return; }
    try {
      sb = window.supabase.createClient(cfg.url, cfg.anonKey);
      const { data } = await sb.auth.getSession();
      session = data.session || null;
      await loadProfile();
      updateAccountChip();
      sb.auth.onAuthStateChange((_evt, s) => {
        session = s || null;
        loadProfile().then(updateAccountChip);
      });
    } catch(e){
      console.warn('[ranking] init fehlgeschlagen:', e);
    }
    wireButtons();
  }

  // ---------- Buttons (in Task 3–6 erweitert) ----------
  function wireButtons(){
    const close = $('fmModalClose'); if(close) close.onclick = hideModal;
    const board = $('btnBoard'); if(board) board.onclick = () => { if(!cfgOk()){ toast('Ranking nicht verfügbar'); return; } openBoard(); };
    const auth = $('btnAuth'); if(auth) auth.onclick = () => {
      if(!cfgOk()){ toast('Login nicht verfügbar'); return; }
      if(session && !profile) showModal('auth-handle'); else showModal('auth-email');
    };
    const out = $('btnSignOut'); if(out) out.onclick = signOut;
    // weitere Buttons werden in den folgenden Tasks verdrahtet
  }

  // Platzhalter-Funktionen, in folgenden Tasks implementiert:
  async function signOut(){}
  async function openBoard(){}

  window.FMRanking = { init, submitScore: async () => {} };
  document.addEventListener('DOMContentLoaded', init);
})();
```

- [ ] **Step 8: Smoke-Test (lokal, ausgeloggt, ohne echte Config)**

Run:
```bash
python3 -m http.server 8080
```
Mit `/browse`: `http://localhost:8080` öffnen.
Expected:
- Spiel startet normal, „Spielen" funktioniert (Ranking-Config = `REPLACE`, daher Ranking deaktiviert — kein Crash).
- Console zeigt `[ranking] Supabase nicht konfiguriert — Ranking deaktiviert.`, **keine** roten Errors.
- Button „🏆 Rangliste" sichtbar; Klick → Toast „Ranking nicht verfügbar".
- „Anmelden"-Link sichtbar.

- [ ] **Step 9: Commit**

```bash
git add vendor/supabase.min.js ranking.js index.html
git commit -m "feat(ranking): SDK vendoren, Config, Boot/Session, Account-Chip, Modal-Gerüst"
```

---

## Task 3: Auth-Flow (E-Mail → Code → Handle)

**Files:**
- Modify: `ranking.js` (Auth-Funktionen + Button-Wiring)

- [ ] **Step 1: Auth-Funktionen in `ranking.js` ergänzen**

Ersetze die Platzhalter-Zeile `async function signOut(){}` durch folgenden Block (alle Auth-Funktionen):

```javascript
  function validHandle(h){ return /^[A-Za-z0-9_]{3,20}$/.test(h); }

  async function sendCode(){
    const email = ($('authEmail').value || '').trim();
    const err = $('authEmailErr'); err.textContent = '';
    if(!email || !email.includes('@')){ err.textContent = 'Bitte gültige E-Mail eingeben.'; return; }
    $('btnSendCode').disabled = true;
    try {
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if(error) throw error;
      pendingEmail = email;
      $('authCodeNote').textContent = 'Code aus der E-Mail an ' + email + ' eingeben.';
      showView('auth-code');
    } catch(e){
      err.textContent = e.message || 'Senden fehlgeschlagen.';
    } finally { $('btnSendCode').disabled = false; }
  }

  async function verifyCode(){
    const token = ($('authCode').value || '').trim();
    const err = $('authCodeErr'); err.textContent = '';
    if(!/^\d{6}$/.test(token)){ err.textContent = '6-stelligen Code eingeben.'; return; }
    $('btnVerifyCode').disabled = true;
    try {
      const { data, error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
      if(error) throw error;
      session = data.session || null;
      await loadProfile();
      updateAccountChip();
      if(profile){ hideModal(); toast('Willkommen zurück, @' + profile.handle); }
      else { showView('auth-handle'); }
    } catch(e){
      err.textContent = e.message || 'Code ungültig oder abgelaufen.';
    } finally { $('btnVerifyCode').disabled = false; }
  }

  async function saveHandle(){
    const handle = ($('authHandle').value || '').trim();
    const err = $('authHandleErr'); err.textContent = '';
    if(!validHandle(handle)){ err.textContent = '3–20 Zeichen: Buchstaben, Zahlen, _'; return; }
    if(!session){ err.textContent = 'Nicht angemeldet.'; return; }
    $('btnSaveHandle').disabled = true;
    try {
      const { error } = await sb.from('profiles').insert({ id: session.user.id, handle });
      if(error){
        if(error.code === '23505'){ err.textContent = 'Handle bereits vergeben.'; return; }
        throw error;
      }
      await loadProfile();      // lädt Profil + migriert lokalen Best
      updateAccountChip();
      hideModal();
      toast('Handle gespeichert: @' + handle);
    } catch(e){
      err.textContent = e.message || 'Speichern fehlgeschlagen.';
    } finally { $('btnSaveHandle').disabled = false; }
  }

  async function signOut(){
    try { await sb.auth.signOut(); } catch(e){}
    session = null; profile = null;
    updateAccountChip(); hideModal();
    toast('Abgemeldet');
  }
```

- [ ] **Step 2: Auth-Buttons verdrahten**

In `wireButtons()` vor dem Kommentar `// weitere Buttons …` einfügen:

```javascript
    const send = $('btnSendCode'); if(send) send.onclick = sendCode;
    const verify = $('btnVerifyCode'); if(verify) verify.onclick = verifyCode;
    const resend = $('btnResendCode'); if(resend) resend.onclick = sendCode;
    const saveH = $('btnSaveHandle'); if(saveH) saveH.onclick = saveHandle;
```

- [ ] **Step 3: Smoke-Test mit echter Config**

Voraussetzung: Task 1 abgeschlossen, `window.FMRUN_SUPABASE.url`/`anonKey` in `index.html` eingetragen.
Mit `/browse` `http://localhost:8080` öffnen, „Anmelden" → eigene E-Mail → „Code senden".
Expected:
- View wechselt zu „Code eingeben", Note nennt die E-Mail.
- E-Mail mit 6-stelligem Code kommt an. Code eingeben → „Handle wählen" erscheint (neuer User).
- Handle eingeben → Modal schließt, Account-Chip zeigt `@handle`.
- Reload → weiterhin `@handle` (Session persistiert).
- Verifikation in DB: `mcp__supabase__execute_sql` → `select handle, best_distance from public.profiles;` zeigt die Zeile.

- [ ] **Step 4: Handle-Konflikt prüfen**

Zweiter Account (anderes E-Mail / Inkognito) → denselben Handle (auch andere Groß-/Kleinschreibung) → „Handle bereits vergeben." erscheint, kein Crash.

- [ ] **Step 5: Commit**

```bash
git add ranking.js
git commit -m "feat(ranking): Auth-Flow E-Mail-OTP -> Code -> Handle"
```

---

## Task 4: Score-Submission + Rang im Game-Over + Spiel-Integration

**Files:**
- Modify: `ranking.js` (`submitScore`)
- Modify: `index.html` (`gameOver()`-Aufruf)

- [ ] **Step 1: `submitScore` in `ranking.js` implementieren**

Ersetze in der Export-Zeile `submitScore: async () => {}` NICHT direkt — definiere stattdessen oberhalb von `window.FMRanking = …` die Funktion und referenziere sie:

```javascript
  async function submitScore(distanceMeters){
    const d = Math.max(0, Math.floor(distanceMeters || 0));
    const rankEl = $('overRank');
    if(!cfgOk() || !session || !profile){
      if(rankEl) rankEl.textContent = '';   // ausgeloggt: keine Rang-Anzeige
      return;
    }
    try {
      const { data: best } = await sb.rpc('submit_score', { p_distance: d });
      if(typeof best === 'number') profile.best_distance = best;
      const { data: rank } = await sb.rpc('my_worldwide_rank');
      if(rankEl && typeof rank === 'number') rankEl.textContent = 'Welt-Rang: #' + rank;
    } catch(e){
      if(rankEl) rankEl.textContent = '';
    }
  }
```

Und ändere die Export-Zeile zu:

```javascript
  window.FMRanking = { init, submitScore };
```

- [ ] **Step 2: Aufruf in `index.html` `gameOver()` einbauen**

In `gameOver()` (aktuell ~Zeile 679–690), direkt nach der Zeile
`document.getElementById('screenOver').classList.remove('hidden');` einfügen:

```javascript
    try { window.FMRanking && window.FMRanking.submitScore(m); } catch(e){}
```

(`m` ist die bereits berechnete `Math.floor(distance)`.)

- [ ] **Step 3: Smoke-Test**

Eingeloggt spielen → sterben.
Expected:
- Game-Over zeigt zusätzlich „Welt-Rang: #1" (bzw. echten Rang).
- `mcp__supabase__execute_sql` → `select handle, best_distance from public.profiles;` zeigt die erreichte Distanz (falls > vorher).
- Erneut mit kleinerer Distanz sterben → `best_distance` in DB sinkt **nicht** (greatest()).
- Ausgeloggt spielen → kein „Welt-Rang"-Text, kein Crash.

- [ ] **Step 4: Lokale-Best-Migration prüfen**

Ausgeloggt, mit hoher Distanz sterben (setzt `localStorage.fmrun_best`). Dann „Anmelden" mit bestehendem Account (ohne neu zu spielen).
Expected: nach Login ist `best_distance` in der DB mindestens so hoch wie der lokale Best (Migration in `loadProfile`).

- [ ] **Step 5: Commit**

```bash
git add ranking.js index.html
git commit -m "feat(ranking): Score-Submission + Welt-Rang im Game-Over + lokale Migration"
```

---

## Task 5: Rangliste-UI (Tabs Freunde / Weltweit)

**Files:**
- Modify: `ranking.js` (`openBoard`, Lade-/Render-Funktionen, Tab-Wiring)

- [ ] **Step 1: Board-Funktionen in `ranking.js` ergänzen**

Ersetze die Platzhalter-Zeile `async function openBoard(){}` durch:

```javascript
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function openBoard(){
    if(!session || !profile){ showModal('auth-email'); toast('Erst anmelden'); return; }
    showModal('board');
    setTab(boardTab);
  }

  function setTab(tab){
    boardTab = tab;
    $('tabFriends').classList.toggle('active', tab === 'friends');
    $('tabWorld').classList.toggle('active', tab === 'world');
    if(tab === 'friends') loadFriendsBoard(); else loadWorldBoard();
  }

  function renderBoard(rows, opts){
    const list = $('boardList');
    if(!rows || !rows.length){ list.innerHTML = '<div class="fmlist-empty">Noch keine Einträge.</div>'; return; }
    list.innerHTML = rows.map((r, i) => {
      const rank = opts && opts.startRank ? (opts.startRank + i) : (i + 1);
      const me = r.is_me ? ' me' : '';
      return '<div class="fmlist-row' + me + '">'
        + '<span class="rank">#' + rank + '</span>'
        + '<span class="who">@' + escapeHtml(r.handle) + '</span>'
        + '<span class="dist">' + (r.best_distance|0) + ' m</span>'
        + '</div>';
    }).join('');
  }

  async function loadFriendsBoard(){
    $('boardList').innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    try {
      const { data, error } = await sb.rpc('friends_leaderboard');
      if(error) throw error;
      renderBoard(data || []);
    } catch(e){ $('boardList').innerHTML = '<div class="fmlist-empty">Fehler beim Laden.</div>'; }
  }

  async function loadWorldBoard(){
    $('boardList').innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    try {
      const { data, error } = await sb.from('profiles')
        .select('handle, best_distance').order('best_distance', { ascending: false }).limit(100);
      if(error) throw error;
      const rows = (data || []).map(r => ({ ...r, is_me: profile && r.handle === profile.handle }));
      renderBoard(rows);
    } catch(e){ $('boardList').innerHTML = '<div class="fmlist-empty">Fehler beim Laden.</div>'; }
  }
```

- [ ] **Step 2: Tab-Buttons verdrahten**

In `wireButtons()` vor dem Kommentar `// weitere Buttons …` einfügen:

```javascript
    const tf = $('tabFriends'); if(tf) tf.onclick = () => setTab('friends');
    const tw = $('tabWorld'); if(tw) tw.onclick = () => setTab('world');
```

- [ ] **Step 3: Smoke-Test**

Eingeloggt → „🏆 Rangliste".
Expected:
- Tab „Freunde" aktiv: zeigt mindestens die eigene Zeile (hervorgehoben, `.me`).
- Tab „Weltweit": zeigt alle Profile nach Distanz sortiert, eigene Zeile hervorgehoben, Rang #1.. fortlaufend.
- Ausgeloggt → „🏆 Rangliste" → Modal fragt nach Login (`auth-email`) + Toast „Erst anmelden".

- [ ] **Step 4: Commit**

```bash
git add ranking.js
git commit -m "feat(ranking): Rangliste-UI mit Tabs Freunde/Weltweit"
```

---

## Task 6: Freunde-Verwaltung (Hinzufügen / Annehmen / Ablehnen / Entfreunden)

**Files:**
- Modify: `ranking.js` (Friends-Funktionen + Wiring)

- [ ] **Step 1: Friends-Funktionen in `ranking.js` ergänzen**

Füge nach den Board-Funktionen (vor `window.FMRanking = …`) ein:

```javascript
  async function openFriends(){
    if(!session || !profile){ showModal('auth-email'); return; }
    showView('friends');
    $('friendErr').textContent = '';
    loadRequestsAndFriends();
  }

  async function addFriend(){
    const handle = ($('friendHandle').value || '').trim();
    const err = $('friendErr'); err.textContent = '';
    if(!validHandle(handle)){ err.textContent = 'Ungültiger Handle.'; return; }
    if(profile && handle.toLowerCase() === profile.handle.toLowerCase()){
      err.textContent = 'Das bist du selbst.'; return;
    }
    $('btnAddFriend').disabled = true;
    try {
      // Profil per Handle finden (case-insensitiv)
      const { data: target, error: e1 } = await sb.from('profiles')
        .select('id, handle').ilike('handle', handle).maybeSingle();
      if(e1) throw e1;
      if(!target){ err.textContent = 'Kein User mit diesem Handle.'; return; }

      // Gibt es bereits eine Beziehung (egal welche Richtung)?
      const { data: existing } = await sb.from('friendships')
        .select('id, requester_id, addressee_id, status')
        .or('and(requester_id.eq.' + session.user.id + ',addressee_id.eq.' + target.id + '),'
          + 'and(requester_id.eq.' + target.id + ',addressee_id.eq.' + session.user.id + ')')
        .maybeSingle();

      if(existing){
        if(existing.status === 'accepted'){ err.textContent = 'Ihr seid bereits Freunde.'; return; }
        // pending: hat der ANDERE mir geschickt? -> automatisch annehmen
        if(existing.addressee_id === session.user.id){
          const { error: e2 } = await sb.from('friendships')
            .update({ status: 'accepted' }).eq('id', existing.id);
          if(e2) throw e2;
          toast('Anfrage angenommen — ihr seid Freunde!');
        } else {
          err.textContent = 'Anfrage läuft bereits.'; return;
        }
      } else {
        const { error: e3 } = await sb.from('friendships')
          .insert({ requester_id: session.user.id, addressee_id: target.id, status: 'pending' });
        if(e3) throw e3;
        toast('Anfrage an @' + target.handle + ' gesendet');
      }
      $('friendHandle').value = '';
      loadRequestsAndFriends();
    } catch(e){
      err.textContent = e.message || 'Fehlgeschlagen.';
    } finally { $('btnAddFriend').disabled = false; }
  }

  async function loadRequestsAndFriends(){
    const reqList = $('requestList'), frList = $('friendList');
    reqList.innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    frList.innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    try {
      // Eingehende Anfragen: ich bin addressee, pending; Requester-Handle joinen
      const { data: reqs } = await sb.from('friendships')
        .select('id, status, requester:profiles!friendships_requester_id_fkey(handle)')
        .eq('addressee_id', session.user.id).eq('status', 'pending');
      reqList.innerHTML = (reqs && reqs.length)
        ? reqs.map(r => '<div class="fmlist-row"><span class="who">@'
            + escapeHtml(r.requester ? r.requester.handle : '?') + '</span>'
            + '<span class="act">'
            + '<button class="fmminibtn ok" data-accept="' + r.id + '">Annehmen</button>'
            + '<button class="fmminibtn no" data-remove="' + r.id + '">X</button>'
            + '</span></div>').join('')
        : '<div class="fmlist-empty">Keine offenen Anfragen.</div>';

      // Akzeptierte Freunde (beide Richtungen)
      const { data: fr } = await sb.from('friendships')
        .select('id, requester_id, addressee_id, status,'
          + ' requester:profiles!friendships_requester_id_fkey(handle),'
          + ' addressee:profiles!friendships_addressee_id_fkey(handle)')
        .eq('status', 'accepted')
        .or('requester_id.eq.' + session.user.id + ',addressee_id.eq.' + session.user.id);
      frList.innerHTML = (fr && fr.length)
        ? fr.map(f => {
            const other = f.requester_id === session.user.id ? f.addressee : f.requester;
            return '<div class="fmlist-row"><span class="who">@'
              + escapeHtml(other ? other.handle : '?') + '</span>'
              + '<span class="act"><button class="fmminibtn no" data-remove="' + f.id + '">Entfernen</button></span></div>';
          }).join('')
        : '<div class="fmlist-empty">Noch keine Freunde.</div>';
    } catch(e){
      reqList.innerHTML = '<div class="fmlist-empty">Fehler.</div>';
      frList.innerHTML = '';
    }
  }

  async function acceptRequest(id){
    try { await sb.from('friendships').update({ status: 'accepted' }).eq('id', id); toast('Angenommen'); }
    catch(e){ toast('Fehlgeschlagen'); }
    loadRequestsAndFriends();
  }
  async function removeFriendship(id){
    try { await sb.from('friendships').delete().eq('id', id); }
    catch(e){ toast('Fehlgeschlagen'); }
    loadRequestsAndFriends();
  }
```

- [ ] **Step 2: Friends-Buttons verdrahten (inkl. Event-Delegation für dynamische Zeilen)**

In `wireButtons()` vor dem Kommentar `// weitere Buttons …` einfügen:

```javascript
    const bf = $('btnFriends'); if(bf) bf.onclick = openFriends;
    const back = $('btnBackBoard'); if(back) back.onclick = () => { showView('board'); setTab(boardTab); };
    const add = $('btnAddFriend'); if(add) add.onclick = addFriend;
    // Delegation: Annehmen/Entfernen auf dynamisch gerenderten Zeilen
    const modal = $('fmModal');
    if(modal) modal.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-accept]'); if(a){ acceptRequest(a.getAttribute('data-accept')); return; }
      const r = ev.target.closest('[data-remove]'); if(r){ removeFriendship(r.getAttribute('data-remove')); return; }
    });
```

- [ ] **Step 3: Smoke-Test (zwei Accounts)**

Account A (Browser 1) und Account B (Inkognito / zweites Gerät), beide mit Handle.
1. A → Rangliste → „Freunde verwalten" → B's Handle → „+".
   Expected: Toast „Anfrage an @B gesendet". Bei A unter „Deine Freunde" noch nichts.
2. B → „Freunde verwalten".
   Expected: unter „Anfragen" steht „@A" mit Annehmen/X.
3. B → „Annehmen".
   Expected: „@A" wandert zu „Deine Freunde"; bei A nach Reload ebenfalls „@B" unter Freunden.
4. A → Rangliste → Tab „Freunde": zeigt A **und** B, nach Distanz sortiert.
5. Auto-Accept: neuer Account C schickt A eine Anfrage; A fügt daraufhin C per Handle hinzu → Toast „Anfrage angenommen — ihr seid Freunde!" (kein Duplikat-Fehler).
6. Entfernen: A → „Entfernen" bei B → B verschwindet aus A's Freundesliste (und nach Reload aus B's).

- [ ] **Step 4: Commit**

```bash
git add ranking.js
git commit -m "feat(ranking): Freunde-Verwaltung (Hinzufügen/Annehmen/Ablehnen/Entfreunden + Auto-Accept)"
```

---

## Task 7: Offline (Service-Worker) + Schluss-Smoke-Test

**Files:**
- Modify: `service-worker.js`

- [ ] **Step 1: PRECACHE + CACHE_NAME aktualisieren**

In `service-worker.js`:
- `const CACHE_NAME = 'fm-run-v11';` → `const CACHE_NAME = 'fm-run-v12';`
- Im `PRECACHE`-Array nach `'./index.html',` zwei Einträge ergänzen:

```javascript
  './ranking.js',
  './vendor/supabase.min.js',
```

- [ ] **Step 2: Verifizieren, dass SW Supabase-API nicht abfängt**

Bestätige in `service-worker.js` (keine Änderung nötig, nur Prüfung): Der `fetch`-Handler enthält
`if (url.origin !== self.location.origin) return;` und `if (req.method !== 'GET') return;`.
→ Cross-Origin-Calls zu `*.supabase.co` und alle POSTs laufen ungehindert durch.

- [ ] **Step 3: Offline-Smoke-Test**

Mit `/browse` Seite laden (eingeloggt), dann Netzwerk offline schalten, Reload.
Expected:
- Spiel lädt aus dem Cache und ist spielbar (inkl. `ranking.js` + vendored SDK, kein 404).
- Rangliste/Login zeigen Lade-/Fehlerzustände statt Crash; Spiel bleibt nutzbar.

- [ ] **Step 4: Schluss-Smoke-Test (online, kompletter Durchlauf)**

Checkliste in einem frischen Browser-Profil:
- [ ] Anmelden (E-Mail → Code → Handle) funktioniert.
- [ ] Spielen + sterben → „Welt-Rang: #X" erscheint, Score landet in DB.
- [ ] Rangliste Freunde + Weltweit laden korrekt, eigene Zeile hervorgehoben.
- [ ] Freund hinzufügen/annehmen/entfernen funktioniert (zweiter Account).
- [ ] Abmelden → Account-Chip „Nicht angemeldet", Spiel weiter spielbar.
- [ ] Console frei von roten Errors im gesamten Flow.

- [ ] **Step 5: RLS-Negativtest (manuell, zwei Accounts)**

Als Account B im Browser-DevTools-Console (B ist eingeloggt, `sb` ist nicht global — daher via App testen oder über Supabase SQL mit gesetztem JWT):
- Über die App lässt sich Bs Profil nie auf As Zeile schreiben (UPDATE-Policy `id = auth.uid()`).
- `select * from friendships` liefert B nur Beziehungen, in denen B vorkommt.
Bestätige zumindest: Worldwide-Liste enthält nur `handle` + `best_distance` (keine E-Mails) — `select * from profiles limit 1` zeigt keine E-Mail-Spalte.

- [ ] **Step 6: Commit**

```bash
git add service-worker.js
git commit -m "feat(pwa): ranking.js + supabase SDK in PRECACHE (offline-fähig), CACHE_NAME v12"
```

---

## Self-Review (vom Plan-Autor durchgeführt)

**Spec-Abdeckung:**
- Email-OTP-Login → Task 3 ✓
- Eindeutiger Handle (änderbar, case-insensitiv) → Schema Task 1 (`profiles_handle_lower_idx`) + Task 3 (`saveHandle`). *Hinweis: Handle-Änderung ist per RLS (`profiles_update`) erlaubt, aber im UI v1 nicht als eigener Button umgesetzt — siehe „Offene Punkte".*
- Freundschaftsanfrage per Handle mit Annahme → Task 6 ✓
- Ranglisten Freunde + Weltweit → Task 5 ✓
- Account optional / anonym spielbar → `cfgOk()`-Guards + `submitScore` no-op ohne Session ✓
- Cheat-Schutz „Client vertrauen" + RLS + `greatest()` → Task 1 ✓
- Lokale-Best-Migration → Task 2 (`loadProfile`) + Task 4 Step 4 ✓
- Offline/SW + Secrets inline → Task 2 + Task 7 ✓

**Typ-/Namens-Konsistenz:** `sb`, `session`, `profile`, `showView`, `setTab`, `boardTab`, `loadRequestsAndFriends`, `removeFriendship`, RPC-Namen (`submit_score`, `friends_leaderboard`, `my_worldwide_rank`) durchgängig identisch verwendet. FK-Constraint-Namen für Supabase-Joins: `friendships_requester_id_fkey` / `friendships_addressee_id_fkey` (PostgREST-Default für `friendships.requester_id → profiles.id`).

**Platzhalter:** Nur `REPLACE_WITH_PROJECT_URL` / `REPLACE_WITH_ANON_KEY` — echte Config-Werte aus Task 1, kein Plan-Platzhalter; `cfgOk()` behandelt den unkonfigurierten Zustand sauber.

## Offene Punkte (v1 bewusst weggelassen — YAGNI)
- **Handle nachträglich ändern** im UI: DB/RLS erlauben es bereits; ein „Handle ändern"-Button kann später trivial ergänzt werden (`sb.from('profiles').update({handle}).eq('id', uid)` mit 23505-Handling wie in `saveHandle`).
- **Edge-Function-Score-Validierung:** bewusst v2 (siehe Spec „Bekannte Grenzen").
