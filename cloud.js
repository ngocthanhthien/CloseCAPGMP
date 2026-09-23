/* Supabase bridge. The original UI runs only after authentication + approved membership. */
(() => {
  'use strict';
  const clone = value => structuredClone(value);
  const stable = value => JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
  });
  const same = (a, b) => stable(a) === stable(b);
  // Supabase Auth only signs in by email/phone, so a Username account uses a synthetic,
  // never-mailed address behind the scenes; the person only ever sees/types the username.
  // Must compute the exact same address the admin-users Edge Function derives on creation.
  function shadowDomain() {
    try { return new URL(config.supabaseUrl).hostname.split('.')[0]+'.users.internal'; }
    catch { return 'users.internal'; }
  }
  function loginIdToEmail(raw) {
    return raw.includes('@') ? raw.toLowerCase() : raw.toLowerCase()+'@'+shadowDomain();
  }
  const defaults = clone(SETTINGS);
  const egressDefaults = {enabled:true,softLimitMB:100,hardLimitMB:200,extraTodayMB:0,extraDate:'',unlockToday:false,unlockDate:''};
  const areaDefaults = AREAS.map(a => ({code:a.code, pic:a.pic}));
  let client, started = false, starting = false, timer, bases = {}, conflicts = new Map(), accessGranted=false;
  let durable = true, saveChain = Promise.resolve(), mediaPending = 0, mediaErrors = 0;
  // High-water mark (server updated_at) of the newest record already merged locally — lets
  // routine polling fetch only what changed instead of re-downloading every record (and its
  // embedded images) every 30 seconds.
  let syncedAt = '';
  let releaseLock;
  // Throttle for the 'online' listener below — a flaky connection (wifi hiccup, laptop sleep/
  // wake) can fire several 'online' events in quick succession; without this each one would
  // re-trigger a sync, and a single genuine drop is more likely than several in a row anyway.
  let lastOnlineSync = 0;
  // --- Data & Egress Control state ---
  // Bytes moved by THIS device today, measured by meteredFetch() below (every real Supabase
  // request/response — no extra network calls made just to "measure"). Persisted with the
  // rest of the cache so a reload doesn't lose today's count; self-resets when the stored
  // date no longer matches today.
  let traffic = {date:'', bytes:0, lastReported:0, lastReportAt:0};
  let todayTotalBytes = 0; // last known SUM across all devices for today (this device's own report included)
  // Original-image uploads deferred while in PROTECTION — each {id,file,meta,size,createdAt}.
  // Kept in the same cached blob as FINDINGS/SETTINGS (structuredClone supports Blob/File), so
  // no new IndexedDB object store/version bump is needed.
  let pendingMedia = [];
  let draining = false;
  let pollTimer;
  const config = window.GMP_CONFIG || {};
  const api = window.GMPCloud = {
    cacheId:'', schedule, backupMedia,
    adminListUsers, adminCreateUser, adminChangeRole, adminSetStatus,
    trafficState
  };
  const localSet = idbSet;

  function status(message, warn = false) {
    $('#cloudBannerText').textContent = message;
    $('#cloudBanner').className = warn ? 'warn' : '';
    $('#cloudSyncStatus').textContent = message;
  }
  function snapshot() {
    return {findings:clone(FINDINGS), settings:clone(SETTINGS),
      deleted:clone(DELETED_IDS), bases:clone(bases), syncedAt,
      traffic:clone(traffic), pendingMedia:clone(pendingMedia)};
  }
  // --- Data & Egress Control ---
  function bodyBytes(body) {
    if(!body) return 0;
    if(typeof body === 'string') return body.length;
    if(body.byteLength != null) return body.byteLength; // ArrayBuffer/typed array
    if(body.size != null) return body.size; // Blob/File
    try { return JSON.stringify(body).length; } catch { return 0; }
  }
  async function meteredFetch(input, init) {
    const reqBytes = bodyBytes(init && init.body);
    const res = await fetch(input, init);
    let resBytes = +(res.headers.get('content-length') || 0);
    if(!resBytes) {
      // The body is already downloaded into this Response; cloning it to read .size reads the
      // local buffer only — it does not issue another network request.
      try { resBytes = (await res.clone().blob()).size; } catch {}
    }
    addTraffic(reqBytes + resBytes);
    return res;
  }
  function addTraffic(bytes) {
    if(!bytes) return;
    const today = todayISO();
    if(traffic.date !== today) traffic = {date:today, bytes:0, lastReported:0, lastReportAt:0};
    traffic.bytes += bytes;
  }
  function egressConfig() {
    return Object.assign(clone(egressDefaults), SETTINGS.egressControl || {});
  }
  // Best local estimate of TOTAL traffic today across every device: the last server-read sum,
  // adjusted for whatever this device has measured locally since its last report to the server
  // (so the number keeps moving between the periodic reports, not just after each one lands).
  function todayMB() {
    if(traffic.date !== todayISO()) return todayTotalBytes/1e6;
    return Math.max(0, todayTotalBytes - traffic.lastReported + traffic.bytes)/1e6;
  }
  function trafficState() {
    const cfg = egressConfig();
    const today = todayISO();
    const mb = todayMB();
    const result = {state:'NORMAL', todayMB:mb, softLimitMB:cfg.softLimitMB, hardLimitMB:cfg.hardLimitMB,
      effectiveHardLimitMB:cfg.hardLimitMB, unlocked:false, pendingMediaCount:pendingMedia.length};
    if(!cfg.enabled) return result;
    result.unlocked = cfg.unlockToday && cfg.unlockDate===today;
    if(result.unlocked) return result;
    const extra = (cfg.extraDate===today) ? (Number(cfg.extraTodayMB)||0) : 0;
    result.effectiveHardLimitMB = (Number(cfg.hardLimitMB)||egressDefaults.hardLimitMB) + extra;
    if(mb >= result.effectiveHardLimitMB) result.state = 'PROTECTION';
    else if(mb >= (Number(cfg.softLimitMB)||egressDefaults.softLimitMB)) result.state = 'DATA_SAVING';
    return result;
  }
  function renderTrafficBadge() {
    const el = $('#cloudTrafficBadge'); if(!el) return;
    const t = trafficState();
    const label = t.state==='PROTECTION' ? '🔴 Protection' : t.state==='DATA_SAVING' ? '🟠 Data Saving' : '🟢 Normal';
    el.textContent = label + (t.pendingMediaCount ? ` • 📷 ${t.pendingMediaCount} pending` : '');
    el.style.color = t.state==='PROTECTION' ? '#b42318' : t.state==='DATA_SAVING' ? '#7a5b00' : '#0b5e52';
  }
  // Piggybacks on the existing sync cadence — never a request per few KB. Reports this
  // device's cumulative today total (not a delta) so a retry/out-of-order call is harmless,
  // then reads back the cross-device sum in the same round trip cost as any other sync query.
  async function reportTrafficIfDue() {
    const today = todayISO();
    if(traffic.date !== today) return;
    const delta = traffic.bytes - traffic.lastReported;
    const dueByTime = Date.now() - traffic.lastReportAt > 300000; // 5 min
    if(delta < 100000 && !(delta>0 && dueByTime)) return;
    try {
      const {error} = await client.rpc('gmp_report_traffic',{p_date:today,p_device:DEVICE_ID,p_bytes:traffic.bytes});
      if(error) throw error;
      traffic.lastReported = traffic.bytes; traffic.lastReportAt = Date.now();
      const {data,error:readErr} = await client.from('gmp_traffic_daily').select('bytes').eq('date',today);
      if(!readErr && data) todayTotalBytes = data.reduce((s,r)=>s+(r.bytes||0),0);
    } catch {} // best-effort — traffic accounting must never block a real sync
  }
  function persist() {
    const copy = snapshot();
    saveChain = saveChain.catch(()=>{}).then(async () => {
      // Keep data and its known server revision in one atomic IndexedDB value.
      const db = await idbOpen();
      await new Promise((resolve,reject)=>{
        const tx = db.transaction(STORE,'readwrite');
        tx.objectStore(STORE).put(copy,'cloudWorkspace');
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = ()=>reject(tx.error || new Error('Không lưu được dữ liệu trên máy'));
      });
      durable = true;
    });
    return saveChain.catch(error=>{
      durable = false;
      status('Không lưu được bản chờ trên máy. Hãy tải bản sao lưu trước khi đóng trang: '+error.message,true);
      throw error;
    });
  }
  function localValue(kind,id) {
    if(kind==='settings') return SETTINGS;
    return DELETED_IDS.some(t=>t.id===id) ? null : FINDINGS.find(f=>f.id===id) || null;
  }
  function changed(kind,id) {
    const base = bases[kind+':'+id];
    const value = localValue(kind,id);
    if(!base) return kind==='settings' ? !same(value,defaults) : !!value;
    return !same(value,base.deleted ? null : base.data);
  }
  function pending() {
    const keys = new Set(Object.keys(bases));
    FINDINGS.forEach(f=>keys.add('finding:'+f.id));
    DELETED_IDS.forEach(t=>keys.add('finding:'+t.id));
    keys.add('settings:main');
    return [...keys].map(key=>({key,kind:key.split(':')[0],id:key.slice(key.indexOf(':')+1)}))
      .filter(({kind,id})=>changed(kind,id));
  }
  function schedule() {
    if(!started) return;
    clearTimeout(timer);
    if(pending().length) status('Có thay đổi trên máy đang chờ gửi lên Supabase.',true);
    timer = setTimeout(()=>sync(true),1500);
  }
  function applyRow(row) {
    if(row.kind==='settings') {
      SETTINGS = Object.assign(clone(defaults),clone(row.data));
      areaDefaults.forEach(original=>{ AREAS.find(a=>a.code===original.code).pic=original.pic; });
      applyAreaPicOverrides();
    } else {
      FINDINGS = FINDINGS.filter(f=>f.id!==row.id);
      DELETED_IDS = DELETED_IDS.filter(t=>t.id!==row.id);
      if(row.deleted) DELETED_IDS.push({id:row.id,deletedAt:Date.parse(row.updated_at)});
      else FINDINGS.push(clone(row.data));
    }
  }
  async function changedRows(since) {
    const rows = [];
    // Keyset pagination (on the unique record_key) handles more rows than the API page limit;
    // the updated_at filter is a fixed boundary from before this fetch started, so it stays
    // correct across pages exactly like the old full-table version did.
    let last = '';
    for(;;) {
      // Explicit column list (same set '*' would return today) so a future heavy column added
      // to this table doesn't silently start riding along on every poll.
      let query = client.from('gmp_records').select('kind,id,record_key,data,revision,deleted,updated_at').order('record_key').limit(100);
      if(since) query = query.gt('updated_at',since);
      if(last) query = query.gt('record_key',last);
      const {data,error} = await query;
      if(error) throw error;
      if(!data.length) break;
      rows.push(...data); last=data[data.length-1].record_key;
    }
    return rows;
  }
  function editing() {
    return document.activeElement?.matches('input,textarea,select') ||
      $('#findingDetailModal').classList.contains('show') || EDITING_FINDINGS.size>0;
  }
  function scheduleBackgroundPoll() {
    clearTimeout(pollTimer);
    const state = trafficState().state;
    if(state==='PROTECTION') { pollTimer = setTimeout(scheduleBackgroundPoll,60000); return; }
    const delay = state==='DATA_SAVING' ? 180000 : 60000;
    pollTimer = setTimeout(async ()=>{
      if(!document.hidden) await sync(true);
      scheduleBackgroundPoll();
    }, delay);
  }
  async function uploadOriginal(file, name) {
    const {error}=await client.storage.from('gmp-mediasave').upload(name,file,{upsert:false,contentType:file.type});
    if(error) throw error;
  }
  // Uploads picked up again after Protection clears — one at a time (not all at once, to avoid
  // a traffic spike right when quota just opened back up); a failure leaves the item queued for
  // the next sync() to retry, rather than looping tightly.
  async function drainPendingMedia() {
    if(draining || !pendingMedia.length || trafficState().state==='PROTECTION') return;
    draining = true;
    try {
      while(pendingMedia.length && trafficState().state!=='PROTECTION') {
        const item = pendingMedia[0];
        try {
          const {data:{user}}=await client.auth.getUser();
          if(!user) break;
          const name=user.id+'/'+crypto.randomUUID()+'_'+(item.file.name||'media').replace(/[^a-zA-Z0-9._-]/g,'_');
          await uploadOriginal(item.file, name);
          pendingMedia.shift();
          await persist();
        } catch { mediaErrors++; break; }
      }
    } finally { draining = false; renderTrafficBadge(); }
  }
  async function sync(silent = false, skipMemberCheck = false, forceFull = false) {
    if(!started || syncing) return;
    if(silent && editing()) { schedule(); return; }
    syncing = true;
    try {
      await saveChain;
      // Check revocation / role changes before each synchronization, except right after
      // start() already verified membership — avoids a redundant round-trip at login.
      if(!skipMemberCheck) await member();
      status('Đang đồng bộ Supabase…');
      let watermark = syncedAt;
      // Capture outbound values before network calls; keep later edits intact.
      for(const change of pending()) {
        if(conflicts.has(change.key)) continue;
        const sent = clone(localValue(change.kind,change.id));
        const {data,error} = await client.rpc('gmp_save_record',{
          p_kind:change.kind,p_id:change.id,p_data:sent || {},p_deleted:sent===null,
          p_revision:bases[change.key]?.revision || 0,p_device:DEVICE_ID
        });
        if(error) {
          if(error.message.includes('GMP_CONFLICT')) { conflicts.set(change.key,null); continue; }
          throw error;
        }
        // Only update the revision that corresponds to the exact sent value.
        bases[change.key] = clone(data);
        if(data.updated_at && data.updated_at > watermark) watermark = data.updated_at;
        if(same(localValue(change.kind,change.id),sent)) applyRow(data);
        await persist();
      }
      // Routine polling only needs records changed since the last successful sync — re-reading
      // every record (and its embedded images) every 60 seconds doesn't scale, and neither does
      // doing that on every network reconnect. Only an explicit manual sync or first-ever login
      // on this device does a full reconciliation (forceFull=true).
      const rows = await changedRows(forceFull ? '' : syncedAt);
      for(const row of rows) {
        const key = row.kind+':'+row.id;
        if(row.updated_at && row.updated_at > watermark) watermark = row.updated_at;
        if(changed(row.kind,row.id)) {
          if(same(localValue(row.kind,row.id),row.deleted ? null : row.data)) {
            bases[key]=clone(row); conflicts.delete(key); // Successful write whose response was lost.
          } else if(!bases[key] || row.revision !== bases[key].revision) conflicts.set(key,row);
        } else { applyRow(row); bases[key]=clone(row); conflicts.delete(key); }
      }
      syncedAt = watermark;
      await persist();
      // Re-reading 100 audit rows on every silent 30s poll (whether or not anyone is looking)
      // was the single largest source of egress here — trim the page size and only pull it on
      // an explicit sync (manual button, first login) or while the Data Input Log tab is the one
      // actually open; the periodic background poll otherwise leaves LOG_ENTRIES as-is. Under
      // Protection even the "tab is open" passive refresh is skipped — Admin can still hit the
      // manual refresh button in that tab (that's !silent, always allowed).
      const logTabOpen = document.querySelector('.tab.active')?.dataset.tab==='log';
      const protectionActive = trafficState().state==='PROTECTION';
      if(!silent || (logTabOpen && !protectionActive)) {
        const {data:logs,error:logError} = await client.from('gmp_audit').select('*').order('ts',{ascending:false}).limit(20);
        if(logError) throw logError;
        LOG_ENTRIES = (logs || []).map(l=>({id:String(l.id),ts:Date.parse(l.ts),user:l.actor_name,
          userCode:l.actor_id,deviceId:l.device,action:l.action,detail:l.detail,area:l.area}));
      }
      await reportTrafficIfDue();
      await persist();
      drainPendingMedia(); // fire-and-forget — never delay the sync this photo happens to piggyback on
      renderTrafficBadge();
      if(!editing()) { fullRerender(); renderDataLog(); fillOwnerDatalist(); }
      renderConflicts();
      const count = pending().length;
      const pendingMediaNote = pendingMedia.length ? ` ${pendingMedia.length} ảnh gốc đang chờ (Data Saving/Protection).` : '';
      status(conflicts.size ? `Có ${conflicts.size} xung đột. Vào Đồng bộ để đối chiếu; bản trên máy vẫn được giữ.` :
        count ? `Còn ${count} thay đổi chờ gửi.` :
        `Đã đồng bộ Supabase lúc ${new Date().toLocaleTimeString('vi-VN')}.` +
        (mediaPending ? ` ${mediaPending} ảnh gốc đang tải.` : '') +
        (mediaErrors ? ` ${mediaErrors} ảnh gốc chưa tải được; ảnh nén vẫn lưu trong Finding.` : '') +
        pendingMediaNote,
        !!(count || conflicts.size || mediaErrors || pendingMedia.length));
    } catch(error) {
      status('Chưa đồng bộ: '+error.message+'. Bản chờ trên máy được giữ; bấm Đồng bộ để thử lại.',true);
    } finally { syncing=false; }
  }
  function download(value,name) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const a=document.createElement('a'); a.href=url; a.download=name; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  function renderConflicts() {
    const box=$('#cloudConflicts'); box.replaceChildren();
    for(const [key,row] of conflicts) {
      const p=document.createElement('p');
      p.textContent='Xung đột: '+(row?.data?.issue || key)+' ';
      const backup=document.createElement('button'); backup.className='btn sm gray'; backup.textContent='Tải hai bản để đối chiếu';
      backup.onclick=()=>download({local:localValue(key.split(':')[0],key.slice(key.indexOf(':')+1)),server:row},'GMP_Conflict.json');
      const use=document.createElement('button'); use.className='btn sm'; use.textContent='Dùng bản máy chủ';
      use.disabled=!row;
      use.onclick=async()=>{
        if(!confirm('Thay bản chờ của mục này bằng bản máy chủ? Hãy tải hai bản để đối chiếu trước nếu cần giữ thay đổi trên máy.')) return;
        applyRow(row); bases[key]=clone(row); conflicts.delete(key); await persist(); fullRerender(); renderConflicts(); schedule();
      };
      p.append(backup,use); box.append(p);
    }
  }

  async function adminInvoke(action, params = {}) {
    if(!client) throw new Error('Chưa kết nối Supabase.');
    if(!CURRENT_USER?.admin) throw new Error('Chỉ Quản trị viên mới có quyền thực hiện chức năng này.');
    const { data, error } = await client.functions.invoke('admin-users', {
      body: { action, ...params }
    });
    if(error) {
      let msg = error.message;
      try {
        if(error.context && typeof error.context.json === 'function') {
          const errBody = await error.context.json();
          if(errBody?.error) msg = errBody.error;
        }
      } catch {}
      throw new Error(msg || 'Lỗi kết nối máy chủ quản trị (admin-users)');
    }
    if(data?.error) throw new Error(data.error);
    return data;
  }
  async function adminListUsers() { return adminInvoke('list-users'); }
  async function adminCreateUser(payload) { return adminInvoke('create-user', payload); }
  async function adminChangeRole(userId, newRole) { return adminInvoke('change-role', { targetUserId: userId, newRole }); }
  async function adminSetStatus(userId, disabled) { return adminInvoke(disabled ? 'disable-user' : 'enable-user', { targetUserId: userId }); }

  async function member() {
    // getSession() reads the already-verified session from local storage (no network round-trip);
    // getUser() would re-verify the JWT with the Auth server every single call. This runs on
    // every sync() — the 60s poll, every debounced save, manual sync, reconnect — so that round-
    // trip was pure overhead: the line right below already re-checks disabled/role against the
    // server on every call, which is the actual revocation check that matters here.
    const {data:{session},error:authError}=await client.auth.getSession();
    const user=session?.user;
    if(authError || !user) { lock('Phiên đăng nhập đã hết hạn. Hãy tải lại trang và đăng nhập.'); throw authError || new Error('Chưa đăng nhập'); }
    if(api.cacheId && !api.cacheId.endsWith('_'+user.id)) {
      lock('Tài khoản đã thay đổi. Tải lại trang để mở dữ liệu đúng tài khoản.');
      throw new Error('Tài khoản đã thay đổi; cần tải lại trang');
    }
    const {data,error}=await client.from('gmp_members').select('user_id,display_name,role,disabled').eq('user_id',user.id).maybeSingle();
    if(error) throw error;
    if(!data) { lock('Tài khoản chưa được cấp quyền. Liên hệ Admin để thêm vào gmp_members.'); throw new Error('Chưa có quyền thành viên'); }
    if(data.disabled) { lock('Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ Quản trị viên.'); throw new Error('Tài khoản bị vô hiệu hóa'); }
    CURRENT_USER={code:user.email,name:data.display_name || user.email,admin:data.role==='admin'};
    accessGranted=true;
    if(started) applyUserUI();
    return user;
  }
  function lock(message) {
    accessGranted=false;
    $('#appShell').hidden=true; $('#loginOverlay').style.display='flex';
    $('#loginErr').textContent=message; $('#cloudSignOut').hidden=false;
    $$('.modalOverlay').forEach(el=>el.classList.remove('show'));
    $('#lightbox').classList.remove('show');
  }
  async function start() {
    if(started || starting) return;
    starting=true;
    try {
      const user=await member();
      api.cacheId = new URL(config.supabaseUrl).hostname+'_'+user.id;
      // One editor per account/project on this browser prevents same-cache tab races.
      if(!navigator.locks) throw new Error('Trình duyệt cần hỗ trợ Web Locks (Chrome/Edge/Safari/Firefox hiện đại)');
      const acquired=await new Promise((resolve,reject)=>{
        navigator.locks.request('gmp-editor-'+api.cacheId,{ifAvailable:true},async lock=>{
          if(!lock) { resolve(false); return; }
          resolve(true); await new Promise(done=>{releaseLock=done;});
        }).catch(reject);
      });
      if(!acquired) throw new Error('App đang mở ở tab khác. Đóng tab đó rồi tải lại trang này.');
      const cache=await idbGet('cloudWorkspace');
      const hadCache=!!cache;
      if(cache) {
        FINDINGS=cache.findings || []; SETTINGS=cache.settings || clone(defaults); DELETED_IDS=cache.deleted || [];
        bases=cache.bases || {}; syncedAt=cache.syncedAt || '';
        traffic = (cache.traffic && cache.traffic.date===todayISO()) ? cache.traffic : {date:todayISO(),bytes:0,lastReported:0,lastReportAt:0};
        pendingMedia = cache.pendingMedia || [];
      } else {
        FINDINGS=[]; SETTINGS=clone(defaults); bases={}; DELETED_IDS=[]; syncedAt='';
        traffic = {date:todayISO(),bytes:0,lastReported:0,lastReportAt:0}; pendingMedia=[];
      }
      await boot();
      started=true;
      // member() already verified access above; skip its redundant re-check on this first sync.
      if(hadCache) {
        // Cache exists: show it immediately and let the network sync refresh it in the background,
        // instead of leaving the user on the login screen for the full round-trip.
        $('#appShell').hidden=false; $('#loginOverlay').style.display='none';
        $('#loginPass').value=''; applyUserUI(); renderUsers();
        sync(false,true);
      } else {
        await sync(false,true);
        if(!accessGranted) return;
        // A failed initial network fetch may show only this authenticated user's own cache.
        $('#appShell').hidden=false; $('#loginOverlay').style.display='none';
        $('#loginPass').value=''; applyUserUI(); renderUsers();
      }
      // Self-rescheduling instead of a fixed setInterval so the cadence can back off under
      // Data & Egress Control: 60s in NORMAL (was a flat 30s before), 180s once Data Saving
      // kicks in, and paused entirely in Protection (re-checked every 60s in case the state
      // improves). The manual "Đồng bộ" button and real edits (schedule()'s 1.5s debounce)
      // are never gated by this — only the idle background poll backs off.
      scheduleBackgroundPoll();
    } catch(error) { releaseLock?.(); $('#loginErr').textContent=error.message; }
    finally { starting=false; }
  }
  async function logout() {
    if(started && (pending().length || mediaPending) && !confirm('Còn thay đổi hoặc ảnh gốc chưa gửi. Bản dữ liệu chờ giữ trên máy cho tài khoản này; ảnh gốc đang tải có thể cần chọn lại. Đăng xuất?')) return;
    lock('Đang đăng xuất…'); started=false; clearTimeout(timer);
    await saveChain.catch(()=>{});
    const {error}=await client.auth.signOut({scope:'local'});
    if(error) { $('#loginErr').textContent=error.message; return; }
    location.reload();
  }
  async function backupMedia(file, meta) {
    if(!started || !file) return;
    // Protection: never lose the photo, never lose the record — the compressed evidence
    // already saved into the Finding/Action is what the GMP workflow actually depends on
    // (see saveFindings()); this original-quality backup file is queued and uploaded once
    // traffic is back under control (Admin +Extra/Unlock, or a new day), not dropped.
    if(trafficState().state==='PROTECTION') {
      pendingMedia.push({id:crypto.randomUUID(), file, meta:meta||null, size:file.size, createdAt:Date.now()});
      await persist();
      renderTrafficBadge();
      return;
    }
    mediaPending++;
    try {
      const {data:{user}}=await client.auth.getUser();
      if(!user) throw new Error('Cần đăng nhập');
      const name=user.id+'/'+crypto.randomUUID()+'_'+file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
      await uploadOriginal(file, name);
    } catch(error) { mediaErrors++; status('Ảnh gốc chưa được sao lưu: '+error.message+'. Giữ file gốc trên máy; ảnh nén vẫn có thể lưu trong Finding.',true); }
    finally { mediaPending--; }
  }

  // Replace persistence entry points, preserving existing reporting and editing UI.
  loadFindings=loadDeletedIds=loadDeletedActionIds=loadLog=async()=>{};
  loadSettings=async()=>applyAreaPicOverrides();
  idbSet=async(key,value)=>{
    if(['findings','settings','deletedFindings','deletedActions'].includes(key)) { await persist(); schedule(); return true; }
    return localSet(key,value);
  };
  logAction=()=>{}; // Server audit is authoritative, never accept client-supplied actor identity.
  saveLog=async()=>{};
  clearOldLogEntries=()=>toast('Nhật ký máy chủ được giữ để truy vết; quản lý tại Supabase.');
  backupJson=async()=>download({findings:FINDINGS,settings:SETTINGS,deletedFindings:DELETED_IDS,
    dataInputLog:LOG_ENTRIES,exportedAt:new Date().toISOString()},'GMP_CloseGap_Backup_'+todayISO()+'.json');
  restoreJson=async file=>{
    if(!CURRENT_USER?.admin) return;
    try {
      const data=JSON.parse(await file.text());
      if(!Array.isArray(data.findings)) throw new Error('Không có danh sách Finding');
      const seen=new Set();
      for(const f of data.findings) {
        if(!f || !/^[a-zA-Z0-9_-]{1,100}$/.test(f.id) || seen.has(f.id) || !Array.isArray(f.actions) || !f.issue || !f.area || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new Error('Finding không hợp lệ hoặc trùng ID');
        seen.add(f.id);
        for(const a of f.actions) if(!/^[a-zA-Z0-9_-]{1,100}$/.test(a.id)) throw new Error('Action ID không hợp lệ');
        for(const image of [f.findingImg,...f.actions.flatMap(a=>[a.evidence,a.confirmEvidence])]) {
          if(image && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image)) throw new Error('Ảnh phải là JPEG/PNG/WebP nhúng');
        }
      }
      if(!confirm(`Nhập/gộp ${data.findings.length} Finding từ JSON? Finding cùng ID sẽ dùng nội dung trong file, mục khác giữ nguyên. Tài khoản cũ không được nhập.`)) return;
      await backupJson();
      const map=new Map(FINDINGS.map(f=>[f.id,f]));
      data.findings.forEach(f=>map.set(f.id,f)); FINDINGS=[...map.values()];
      DELETED_IDS=DELETED_IDS.filter(t=>!seen.has(t.id));
      if(data.settings) SETTINGS=Object.assign(SETTINGS,data.settings);
      await persist(); schedule(); fullRerender();
      toast('Đã nhập trên máy; theo dõi thanh Đồng bộ để xác nhận đã gửi lên Supabase.');
    } catch(error) { toast('Không nhập được: '+error.message); }
  };
  clearAllData=async()=>{
    if(!CURRENT_USER?.admin || !confirm('Đánh dấu xoá toàn bộ Finding đang có? Tài khoản Supabase giữ nguyên. App sẽ tải bản sao lưu trước.')) return;
    await backupJson(); DELETED_IDS=FINDINGS.map(f=>({id:f.id,deletedAt:Date.now()})); FINDINGS=[];
    await persist(); schedule(); fullRerender();
  };
  const originalMail=renderMail;
  renderMail=()=>{ originalMail(); if(!CURRENT_USER?.admin) $$('[data-mailemail],[data-mailpic],#saveMailBtn').forEach(el=>el.disabled=true); };
  // Chrome/Edge only show their "Save password?" prompt for SPA logins (no real page
  // navigation on submit) when explicitly told via the Credential Management API.
  // Firefox/Safari already offer to save on the native 'submit' event below, using the
  // autocomplete="username"/"current-password" attributes already on the fields.
  $('#cloudLoginForm').addEventListener('submit',async event=>{
    event.preventDefault(); if(!client) return;
    $('#loginBtn').disabled=true; $('#loginErr').textContent='Đang đăng nhập…';
    // Users type a plain username (no email); Admin can still type a real email. Both map
    // to a Supabase Auth email — see loginIdToEmail(). The browser only ever remembers/shows
    // what was actually typed (raw), never the synthetic address used for the API call.
    const raw=$('#loginUser').value.trim(), password=$('#loginPass').value;
    try {
      const {error}=await client.auth.signInWithPassword({email:loginIdToEmail(raw),password});
      if(error) throw error;
      if(window.PasswordCredential) {
        navigator.credentials.store(new PasswordCredential({id:raw,password,name:raw})).catch(()=>{});
      }
      await start();
    } catch(error) { $('#loginErr').textContent=error.message; }
    finally { $('#loginBtn').disabled=false; }
  });
  // Offer to auto-fill a credential the browser already remembers for this site, so a
  // returning user on a trusted device only needs to press "Đăng nhập". Never auto-submits.
  if(window.PasswordCredential && navigator.credentials) {
    navigator.credentials.get({password:true,mediation:'optional'}).then(cred=>{
      if(cred && cred.type==='password' && !$('#loginUser').value) {
        $('#loginUser').value=cred.id; $('#loginPass').value=cred.password;
      }
    }).catch(()=>{});
  }
  $('#logoutBtn').onclick=event=>{event.preventDefault();logout();};
  $('#cloudSignOut').onclick=logout;
  // Manual sync is an infrequent, explicit moment — do a full reconciliation then as a safety
  // net against drift (e.g. a row an admin removed directly in SQL), while the silent background
  // poll AND a network reconnect both stay incremental (a reconnect is common enough — wifi
  // hiccups, laptop sleep/wake — that re-downloading every embedded image each time was a real
  // egress cost; syncedAt already covers genuine drift on the next full sync anyway).
  $('#oneClickSyncBtn').onclick=()=>sync(false,false,true);
  $('#cloudBackupBtn').onclick=()=>backupJson();
  $('#logClearOldBtn').closest('.field').remove();
  window.addEventListener('online',()=>{
    const now=Date.now();
    if(now-lastOnlineSync<60000) return;
    lastOnlineSync=now;
    sync(true);
  });
  window.addEventListener('beforeunload',event=>{
    if(started && (pending().length || mediaPending || !durable)) {event.preventDefault();event.returnValue='';}
  });
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(config.supabaseUrl || '') || !config.supabaseKey) {
    $('#loginErr').textContent='Chưa kết nối Supabase. Quản trị viên cần điền Project URL và publishable key trong config.js, rồi chạy SQL khởi tạo.';
    $('#loginBtn').disabled=true; return;
  }
  let keyRole='';
  try {keyRole=JSON.parse(atob(config.supabaseKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role;} catch {}
  if(config.supabaseKey.startsWith('sb_secret_') || keyRole==='service_role') { $('#loginErr').textContent='Sai loại key: chỉ dùng publishable/anon key.'; $('#loginBtn').disabled=true; return; }
  if(!window.supabase) { $('#loginErr').textContent='Không tải được thư viện Supabase. Kiểm tra thư mục vendor.'; return; }
  // global.fetch: every request this client makes (postgrest, rpc, storage, auth) is routed
  // through meteredFetch so Data & Egress Control can measure real traffic without issuing a
  // single extra request just to "monitor".
  client=window.supabase.createClient(config.supabaseUrl,config.supabaseKey,{global:{fetch:meteredFetch}});
  client.auth.onAuthStateChange((event,session)=>{
    if(started && (event==='SIGNED_OUT' || (session && session.user.id!==api.cacheId.split('_').pop()))) lock('Phiên đăng nhập đã thay đổi. Tải lại trang để tiếp tục.');
  });
  client.auth.getSession().then(({data:{session},error})=>{
    if(error) $('#loginErr').textContent=error.message;
    else if(session) start();
  });
})();
