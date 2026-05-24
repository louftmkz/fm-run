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

  // ---------- Auth-Funktionen ----------
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

  // ---------- Score-Submission ----------
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

  // ---------- Board-Funktionen ----------
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

  // ---------- Freunde-Verwaltung ----------
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

  // ---------- Buttons ----------
  function wireButtons(){
    const close = $('fmModalClose'); if(close) close.onclick = hideModal;
    const board = $('btnBoard'); if(board) board.onclick = () => { if(!cfgOk()){ toast('Ranking nicht verfügbar'); return; } openBoard(); };
    const auth = $('btnAuth'); if(auth) auth.onclick = () => {
      if(!cfgOk()){ toast('Login nicht verfügbar'); return; }
      if(session && !profile) showModal('auth-handle'); else showModal('auth-email');
    };
    const out = $('btnSignOut'); if(out) out.onclick = signOut;
    // Auth-Buttons
    const send = $('btnSendCode'); if(send) send.onclick = sendCode;
    const verify = $('btnVerifyCode'); if(verify) verify.onclick = verifyCode;
    const resend = $('btnResendCode'); if(resend) resend.onclick = sendCode;
    const saveH = $('btnSaveHandle'); if(saveH) saveH.onclick = saveHandle;
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
      const a = ev.target.closest('[data-accept]'); if(a){ acceptRequest(a.getAttribute('data-accept')); return; }
      const r = ev.target.closest('[data-remove]'); if(r){ removeFriendship(r.getAttribute('data-remove')); return; }
    });
  }

  window.FMRanking = { init, submitScore };
  document.addEventListener('DOMContentLoaded', init);
})();
