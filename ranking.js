// FM RUN — Ranking-Client (Supabase). Defensiv: jeder Fehler bleibt lokal,
// das Spiel selbst läuft immer weiter.
(() => {
  'use strict';

  const cfg = window.FMRUN_SUPABASE || {};
  let sb = null;        // Supabase-Client
  let session = null;   // simple Session: { userId, handle } aus localStorage
  let profile = null;   // { id, handle, best_distance }
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
    if(session && profile){
      status.textContent = '@' + profile.handle;
      authBtn.classList.add('hidden');
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
    if(!session || !session.userId) return;
    const { data, error } = await sb.from('profiles')
      .select('id, handle, best_distance').eq('id', session.userId).maybeSingle();
    if(!error && data) profile = data;
    // Lokalen Highscore migrieren (greatest() ist idempotent)
    if(profile && session && session.userId){
      let localBest = 0;
      try { localBest = parseInt(localStorage.getItem('fmrun_best') || '0', 10) || 0; } catch(e){}
      if(localBest > (profile.best_distance || 0)){
        try { const { data } = await sb.rpc('submit_score_by_id', { p_user_id: session.userId, p_distance: localBest });
              if(typeof data === 'number') profile.best_distance = data; } catch(e){}
      }
    }
  }

  // ---------- Auth-Funktionen ----------
  function validHandle(h){ return /^[A-Za-z0-9_]{3,20}$/.test(h); }
  function saveSession(s){ try { localStorage.setItem('fmrun_session', JSON.stringify(s)); } catch(e){} }
  function loadSession(){ try { return JSON.parse(localStorage.getItem('fmrun_session') || 'null'); } catch(e){ return null; } }
  function clearSession(){ try { localStorage.removeItem('fmrun_session'); } catch(e){} }

  async function signUp(){
    const handle = ($('signupHandle').value || '').trim();
    const password = $('signupPassword').value || '';
    const passwordConfirm = $('signupPasswordConfirm').value || '';
    const err = $('signupErr'); err.textContent = '';

    if(!validHandle(handle)){ err.textContent = 'Handle: 3–20 Zeichen (A-Z, 0-9, _)'; return; }
    if(password.length < 6){ err.textContent = 'Passwort: mindestens 6 Zeichen'; return; }
    if(password !== passwordConfirm){ err.textContent = 'Passwörter stimmen nicht überein'; return; }

    $('btnSignUp').disabled = true;
    try {
      // Check if handle exists
      const { data: exists } = await sb.rpc('handle_exists', { p_handle: handle });
      if(exists){ err.textContent = 'Handle bereits vergeben'; return; }

      // Hash password with bcrypt (10 rounds)
      const passwordHash = await bcrypt.hash(password, 10);

      // Generate unique user ID
      const userId = crypto.randomUUID();

      // Insert profile with password_hash
      const { error: insertErr } = await sb.from('profiles')
        .insert({ id: userId, handle, password_hash: passwordHash });

      if(insertErr){
        if(insertErr.code === '23505'){ err.textContent = 'Handle bereits vergeben'; return; }
        throw insertErr;
      }

      // Create session
      session = { userId, handle };
      saveSession(session);
      await loadProfile();
      updateAccountChip();
      hideModal();
      toast('Willkommen, @' + handle + '!');
    } catch(e){
      err.textContent = e.message || 'Registrierung fehlgeschlagen';
    } finally { $('btnSignUp').disabled = false; }
  }

  async function signIn(){
    const handle = ($('loginHandle').value || '').trim();
    const password = $('loginPassword').value || '';
    const err = $('loginErr'); err.textContent = '';

    if(!validHandle(handle)){ err.textContent = 'Ungültiger Handle'; return; }
    if(!password){ err.textContent = 'Passwort eingeben'; return; }

    $('btnSignIn').disabled = true;
    try {
      // Fetch profile by handle (case-insensitive)
      const { data: profiles, error } = await sb.from('profiles')
        .select('id, handle, password_hash, best_distance')
        .ilike('handle', handle)
        .maybeSingle();

      if(error) throw error;
      if(!profiles){
        err.textContent = 'Handle oder Passwort falsch';
        return;
      }

      // Compare password with stored hash using bcrypt
      const isValid = await bcrypt.compare(password, profiles.password_hash);
      if(!isValid){
        err.textContent = 'Handle oder Passwort falsch';
        return;
      }

      // Create session
      session = { userId: profiles.id, handle: profiles.handle };
      saveSession(session);
      await loadProfile();
      updateAccountChip();
      hideModal();
      toast('Willkommen zurück, @' + profiles.handle);
    } catch(e){
      err.textContent = e.message || 'Anmeldung fehlgeschlagen';
    } finally { $('btnSignIn').disabled = false; }
  }

  function signOut(){
    clearSession();
    session = null; profile = null;
    updateAccountChip(); hideModal();
    toast('Abgemeldet');
  }

  // ---------- Score-Submission ----------
  async function submitScore(distanceMeters){
    const d = Math.max(0, Math.floor(distanceMeters || 0));
    const rankEl = $('overRank');
    if(!cfgOk() || !session || !session.userId || !profile){
      if(rankEl) rankEl.textContent = '';   // ausgeloggt: keine Rang-Anzeige
      return;
    }
    try {
      const { data: best } = await sb.rpc('submit_score_by_id', { p_user_id: session.userId, p_distance: d });
      if(typeof best === 'number') profile.best_distance = best;
      const { data: rank } = await sb.rpc('my_worldwide_rank_by_id', { p_user_id: session.userId });
      if(rankEl && typeof rank === 'number') rankEl.textContent = 'Welt-Rang: #' + rank;
    } catch(e){
      if(rankEl) rankEl.textContent = '';
    }
  }

  // ---------- Board-Funktionen ----------
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function openBoard(){
    if(!session || !profile){ showModal('auth-signup'); toast('Erst anmelden'); return; }
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
    if(!session || !session.userId){
      $('boardList').innerHTML = '<div class="fmlist-empty">Nicht angemeldet.</div>';
      return;
    }
    try {
      const { data, error } = await sb.rpc('friends_leaderboard_by_id', { p_user_id: session.userId });
      if(error) throw error;
      renderBoard(data || []);
    } catch(e){ $('boardList').innerHTML = '<div class="fmlist-empty">Fehler beim Laden.</div>'; }
  }

  async function loadWorldBoard(){
    $('boardList').innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    try {
      const { data, error } = await sb.from('profiles')
        .select('id, handle, best_distance').order('best_distance', { ascending: false }).limit(100);
      if(error) throw error;
      const rows = (data || []).map(r => ({ ...r, is_me: !!(session && r.id === session.userId) }));
      renderBoard(rows);
      if(session && session.userId){
        try {
          const { data: rank } = await sb.rpc('my_worldwide_rank_by_id', { p_user_id: session.userId });
          if(typeof rank === 'number'){
            $('boardList').insertAdjacentHTML('beforeend',
              '<div class="fmlist-empty">Dein Welt-Rang: #' + rank + '</div>');
          }
        } catch(e){}
      }
    } catch(e){ $('boardList').innerHTML = '<div class="fmlist-empty">Fehler beim Laden.</div>'; }
  }

  // ---------- Freunde-Verwaltung ----------
  async function openFriends(){
    if(!session || !profile){ showModal('auth-signup'); return; }
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
        .or('and(requester_id.eq.' + session.userId + ',addressee_id.eq.' + target.id + '),'
          + 'and(requester_id.eq.' + target.id + ',addressee_id.eq.' + session.userId + ')')
        .maybeSingle();

      if(existing){
        if(existing.status === 'accepted'){ err.textContent = 'Ihr seid bereits Freunde.'; return; }
        // pending: hat der ANDERE mir geschickt? -> automatisch annehmen
        if(existing.addressee_id === session.userId){
          const { error: e2 } = await sb.from('friendships')
            .update({ status: 'accepted' }).eq('id', existing.id);
          if(e2) throw e2;
          toast('Anfrage angenommen — ihr seid Freunde!');
        } else {
          err.textContent = 'Anfrage läuft bereits.'; return;
        }
      } else {
        const { error: e3 } = await sb.from('friendships')
          .insert({ requester_id: session.userId, addressee_id: target.id, status: 'pending' });
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
    const reqList = $('requestList'), frList = $('friendList'), sentList = $('sentList');
    reqList.innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    if(sentList) sentList.innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    frList.innerHTML = '<div class="fmlist-empty">Lädt…</div>';
    try {
      // Eingehende Anfragen: ich bin addressee, pending; Requester-Handle joinen
      const { data: reqs } = await sb.from('friendships')
        .select('id, status, requester:profiles!friendships_requester_id_fkey(handle)')
        .eq('addressee_id', session.userId).eq('status', 'pending');
      reqList.innerHTML = (reqs && reqs.length)
        ? reqs.map(r => '<div class="fmlist-row"><span class="who">@'
            + escapeHtml(r.requester ? r.requester.handle : '?') + '</span>'
            + '<span class="act">'
            + '<button class="fmminibtn ok" data-accept="' + r.id + '">Annehmen</button>'
            + '<button class="fmminibtn no" data-remove="' + r.id + '">X</button>'
            + '</span></div>').join('')
        : '<div class="fmlist-empty">Keine offenen Anfragen.</div>';

      // Ausgehende Anfragen: ich bin requester, pending; Addressee-Handle joinen
      const { data: sent } = await sb.from('friendships')
        .select('id, status, addressee:profiles!friendships_addressee_id_fkey(handle)')
        .eq('requester_id', session.userId).eq('status', 'pending');
      $('sentList').innerHTML = (sent && sent.length)
        ? sent.map(s => '<div class="fmlist-row"><span class="who">@'
            + escapeHtml(s.addressee ? s.addressee.handle : '?') + '</span>'
            + '<span class="dist">ausstehend</span>'
            + '<span class="act"><button class="fmminibtn no" data-remove="' + s.id + '">X</button></span></div>').join('')
        : '<div class="fmlist-empty">Keine gesendeten Anfragen.</div>';

      // Akzeptierte Freunde (beide Richtungen)
      const { data: fr } = await sb.from('friendships')
        .select('id, requester_id, addressee_id, status,'
          + ' requester:profiles!friendships_requester_id_fkey(handle),'
          + ' addressee:profiles!friendships_addressee_id_fkey(handle)')
        .eq('status', 'accepted')
        .or('requester_id.eq.' + session.userId + ',addressee_id.eq.' + session.userId);
      frList.innerHTML = (fr && fr.length)
        ? fr.map(f => {
            const other = f.requester_id === session.userId ? f.addressee : f.requester;
            return '<div class="fmlist-row"><span class="who">@'
              + escapeHtml(other ? other.handle : '?') + '</span>'
              + '<span class="act"><button class="fmminibtn no" data-remove="' + f.id + '">Entfernen</button></span></div>';
          }).join('')
        : '<div class="fmlist-empty">Noch keine Freunde.</div>';
    } catch(e){
      reqList.innerHTML = '<div class="fmlist-empty">Fehler.</div>';
      if(sentList) sentList.innerHTML = '';
      frList.innerHTML = '';
    }
  }

  async function acceptRequest(id){
    try {
      await sb.from('friendships').update({ status: 'accepted' }).eq('id', id);
      toast('Angenommen');
      loadRequestsAndFriends();
    } catch(e){ toast('Fehlgeschlagen'); }
  }
  async function removeFriendship(id){
    try {
      await sb.from('friendships').delete().eq('id', id);
      loadRequestsAndFriends();
    } catch(e){ toast('Fehlgeschlagen'); }
  }

  // ---------- Boot ----------
  async function init(){
    wireButtons();
    if(!cfgOk()){ console.info('[ranking] Supabase nicht konfiguriert — Ranking deaktiviert.'); return; }
    try {
      sb = window.supabase.createClient(cfg.url, cfg.anonKey);
      // Load session from localStorage
      session = loadSession();
      if(session){
        await loadProfile();
        updateAccountChip();
      }
    } catch(e){
      console.warn('[ranking] init fehlgeschlagen:', e);
    }
  }

  // ---------- Buttons ----------
  function wireButtons(){
    const close = $('fmModalClose'); if(close) close.onclick = hideModal;
    const board = $('btnBoard'); if(board) board.onclick = () => { if(!cfgOk()){ toast('Ranking nicht verfügbar'); return; } openBoard(); };
    const auth = $('btnAuth'); if(auth) auth.onclick = () => {
      if(!cfgOk()){ toast('Login nicht verfügbar'); return; }
      showModal('auth-signup');
    };
    const out = $('btnSignOut'); if(out) out.onclick = signOut;
    // Auth-Buttons (neue Handle+Password Auth)
    const signup = $('btnSignUp'); if(signup) signup.onclick = signUp;
    const signin = $('btnSignIn'); if(signin) signin.onclick = signIn;
    const toLogin = $('btnToLogin'); if(toLogin) toLogin.onclick = () => showView('auth-login');
    const toSignup = $('btnToSignup'); if(toSignup) toSignup.onclick = () => showView('auth-signup');
    // Tab-Buttons
    const tf = $('tabFriends'); if(tf) tf.onclick = () => setTab('friends');
    const tw = $('tabWorld'); if(tw) tw.onclick = () => setTab('world');
    // Freunde-Buttons
    const bf = $('btnFriends'); if(bf) bf.onclick = openFriends;
    const back = $('btnBackBoard'); if(back) back.onclick = () => { showView('board'); setTab(boardTab); };
    const add = $('btnAddFriend'); if(add) add.onclick = addFriend;
    // Delegation: Annehmen/Entfernen auf dynamisch gerenderten Zeilen
    const modal = $('fmModal');
    if(modal) modal.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-accept]'); if(a){ a.disabled = true; acceptRequest(a.getAttribute('data-accept')); return; }
      const r = ev.target.closest('[data-remove]'); if(r){ r.disabled = true; removeFriendship(r.getAttribute('data-remove')); return; }
    });
  }

  window.FMRanking = { init, submitScore };
  document.addEventListener('DOMContentLoaded', init);
})();
