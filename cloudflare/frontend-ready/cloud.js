/* Cloudflare bridge — replaces the Supabase bridge (cloud.js) with the same architecture,
   same window.GMPCloud contract, same local-first/optimistic-concurrency/incremental-sync
   design, talking to the Cloudflare Worker API (cloudflare/worker/) instead of Supabase.
   NOT YET LIVE — staged in cloudflare/frontend-ready/ until cutover is confirmed. To cut
   over: copy this file and config.js over the live cloud.js/config.js (or repoint the
   <script src> in index.html), bump the cache-busting ?v=, and publish. */
(() => {
  'use strict';
  const clone = value => structuredClone(value);
  const stable = value => JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
  });
  const same = (a, b) => stable(a) === stable(b);
  const defaults = clone(SETTINGS);
  const areaDefaults = AREAS.map(a => ({code:a.code, pic:a.pic}));
  let started = false, starting = false, timer, bases = {}, conflicts = new Map(), accessGranted=false;
  let durable = true, saveChain = Promise.resolve(), mediaPending = 0, mediaErrors = 0;
  let syncedAt = '';
  let releaseLock;
  let lastOnlineSync = 0;
  let token = null;            // JWT, replaces Supabase's managed session
  let traffic = {date:'', bytes:0, lastReported:0, lastReportAt:0};
  let todayTotalBytes = 0;
  let pendingMedia = [];
  let draining = false;
  let pollTimer;
  const config = window.GMP_CONFIG || {};
  const api = window.GMPCloud = {
    cacheId:'', schedule, backupMedia,
    adminListUsers, adminCreateUser, adminChangeRole, adminSetStatus, trafficState
  };
  const localSet = idbSet;
  const TOKEN_KEY = 'gmp_cf_token';

  function apiUrl(path) { return (config.apiBaseUrl||'').replace(/\/$/,'') + path; }

  function status(message, warn = false) {
    $('#cloudBannerText').textContent = message;
    $('#cloudBanner').className = warn ? 'warn' : '';
    $('#cloudSyncStatus').textContent = message;
  }

  // --- Data & Egress Control: measure every real request/response this bridge makes. ---
  function bodyBytes(body) {
    if(!body) return 0;
    if(typeof body === 'string') return body.length;
    if(body.byteLength != null) return body.byteLength;
    if(body.size != null) return body.size;
    try { return JSON.stringify(body).length; } catch { return 0; }
  }
  function addTraffic(bytes) {
    if(!bytes) return;
    const today = todayISO();
    if(traffic.date !== today) traffic = {date:today, bytes:0, lastReported:0, lastReportAt:0};
    traffic.bytes += bytes;
  }
  async function meteredFetch(path, options = {}) {
    const headers = { ...(options.headers||{}) };
    if(token) headers['Authorization'] = 'Bearer '+token;
    const reqBytes = bodyBytes(options.body);
    const res = await fetch(apiUrl(path), { ...options, headers });
    let resBytes = +(res.headers.get('content-length') || 0);
    if(!resBytes) { try { resBytes = (await res.clone().blob()).size; } catch {} }
    addTraffic(reqBytes + resBytes);
    return res;
  }
  async function apiCall(path, options = {}) {
    const res = await meteredFetch(path, options);
    let body = null;
    try { body = await res.json(); } catch {}
    if(!res.ok) throw new Error((body && body.error) || ('HTTP '+res.status));
    return body;
  }
  function egressConfig() {
    const d = {enabled:true,softLimitMB:100,hardLimitMB:200,extraTodayMB:0,extraDate:'',unlockToday:false,unlockDate:''};
    return Object.assign(d, SETTINGS.egressControl || {});
  }
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
    result.effectiveHardLimitMB = (Number(cfg.hardLimitMB)||200) + extra;
    if(mb >= result.effectiveHardLimitMB) result.state = 'PROTECTION';
    else if(mb >= (Number(cfg.softLimitMB)||100)) result.state = 'DATA_SAVING';
    return result;
  }
  function renderTrafficBadge() {
    const el = $('#cloudTrafficBadge'); if(!el) return;
    const t = trafficState();
    const label = t.state==='PROTECTION' ? '🔴 Protection' : t.state==='DATA_SAVING' ? '🟠 Data Saving' : '🟢 Normal';
    el.textContent = label + (t.pendingMediaCount ? ` • 📷 ${t.pendingMediaCount} pending` : '');
    el.style.color = t.state==='PROTECTION' ? '#b42318' : t.state==='DATA_SAVING' ? '#7a5b00' : '#0b5e52';
  }
  async function reportTrafficIfDue() {
    const today = todayISO();
    if(traffic.date !== today) return;
    const delta = traffic.bytes - traffic.lastReported;
    const dueByTime = Date.now() - traffic.lastReportAt > 300000;
    if(delta < 100000 && !(delta>0 && dueByTime)) return;
    try {
      const res = await apiCall('/traffic/report', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({date:today, device:DEVICE_ID, bytes:traffic.bytes})});
      traffic.lastReported = traffic.bytes; traffic.lastReportAt = Date.now();
      if(typeof res.totalBytes === 'number') todayTotalBytes = res.totalBytes;
    } catch {} // best-effort — traffic accounting must never block a real sync
  }

  function snapshot() {
    return {findings:clone(FINDINGS), settings:clone(SETTINGS),
      deleted:clone(DELETED_IDS), bases:clone(bases), syncedAt,
      traffic:clone(traffic), pendingMedia:clone(pendingMedia)};
  }
  function persist() {
    const copy = snapshot();
    saveChain = saveChain.catch(()=>{}).then(async () => {
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
    if(pending().length) status('Có thay đổi trên máy đang chờ gửi lên máy chủ.',true);
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
    // The Worker does the keyset-pagination loop server-side and returns every matching row
    // in one response — no client-side pagination loop needed (unlike the Supabase version,
    // which paginated against PostgREST directly from the browser).
    const qs = since ? ('?since='+encodeURIComponent(since)) : '';
    const res = await apiCall('/records'+qs);
    return res.rows;
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
  async function drainPendingMedia() {
    if(draining || !pendingMedia.length || trafficState().state==='PROTECTION') return;
    draining = true;
    try {
      while(pendingMedia.length && trafficState().state!=='PROTECTION') {
        const item = pendingMedia[0];
        try {
          await uploadOriginal(item.file, item.file.name || 'media');
          pendingMedia.shift();
          await persist();
        } catch { mediaErrors++; break; }
      }
    } finally { draining = false; renderTrafficBadge(); }
  }
  async function uploadOriginal(file, name) {
    const safe = String(name||'media').replace(/[^a-zA-Z0-9._-]/g,'_');
    const res = await meteredFetch('/media/upload?name='+encodeURIComponent(safe), {
      method:'PUT', headers:{'Content-Type':file.type}, body:file
    });
    let body = null; try { body = await res.json(); } catch {}
    if(!res.ok) throw new Error((body && body.error) || ('HTTP '+res.status));
  }
  async function sync(silent = false, skipMemberCheck = false, forceFull = false) {
    if(!started || syncing) return;
    if(silent && editing()) { schedule(); return; }
    syncing = true;
    try {
      await saveChain;
      if(!skipMemberCheck) await member();
      status('Đang đồng bộ…');
      let watermark = syncedAt;
      for(const change of pending()) {
        if(conflicts.has(change.key)) continue;
        const sent = clone(localValue(change.kind,change.id));
        let data, error;
        try {
          data = await apiCall('/records', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
            p_kind:change.kind,p_id:change.id,p_data:sent || {},p_deleted:sent===null,
            p_revision:bases[change.key]?.revision || 0,p_device:DEVICE_ID
          })});
        } catch(e) { error = e; }
        if(error) {
          if(error.message.includes('GMP_CONFLICT')) { conflicts.set(change.key,null); continue; }
          throw error;
        }
        bases[change.key] = clone(data);
        if(data.updated_at && data.updated_at > watermark) watermark = data.updated_at;
        if(same(localValue(change.kind,change.id),sent)) applyRow(data);
        await persist();
      }
      const rows = await changedRows(forceFull ? '' : syncedAt);
      for(const row of rows) {
        const key = row.kind+':'+row.id;
        if(row.updated_at && row.updated_at > watermark) watermark = row.updated_at;
        if(changed(row.kind,row.id)) {
          if(same(localValue(row.kind,row.id),row.deleted ? null : row.data)) {
            bases[key]=clone(row); conflicts.delete(key);
          } else if(!bases[key] || row.revision !== bases[key].revision) conflicts.set(key,row);
        } else { applyRow(row); bases[key]=clone(row); conflicts.delete(key); }
      }
      syncedAt = watermark;
      const logTabOpen = document.querySelector('.tab.active')?.dataset.tab==='log';
      const protectionActive = trafficState().state==='PROTECTION';
      if(!silent || (logTabOpen && !protectionActive)) {
        const res = await apiCall('/audit?limit=20');
        LOG_ENTRIES = (res.rows || []).map(l=>({id:String(l.id),ts:Date.parse(l.ts),user:l.actor_name,
          userCode:l.actor_id,deviceId:l.device,action:l.action,detail:l.detail,area:l.area}));
      }
      await reportTrafficIfDue();
      await persist();
      drainPendingMedia();
      renderTrafficBadge();
      if(!editing()) { fullRerender(); renderDataLog(); fillOwnerDatalist(); }
      renderConflicts();
      const count = pending().length;
      const pendingMediaNote = pendingMedia.length ? ` ${pendingMedia.length} ảnh gốc đang chờ (Data Saving/Protection).` : '';
      status(conflicts.size ? `Có ${conflicts.size} xung đột. Vào Đồng bộ để đối chiếu; bản trên máy vẫn được giữ.` :
        count ? `Còn ${count} thay đổi chờ gửi.` :
        `Đã đồng bộ lúc ${new Date().toLocaleTimeString('vi-VN')}.` +
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

  async function adminInvoke(path, options) {
    if(!CURRENT_USER?.admin) throw new Error('Chỉ Quản trị viên mới có quyền thực hiện chức năng này.');
    return apiCall(path, options);
  }
  async function adminListUsers() {
    const res = await adminInvoke('/admin/users'); return { users: res.users };
  }
  async function adminCreateUser(payload) {
    return adminInvoke('/admin/users', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
  }
  async function adminChangeRole(userId, newRole) {
    return adminInvoke('/admin/users/'+encodeURIComponent(userId)+'/role', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({newRole})});
  }
  async function adminSetStatus(userId, disabled) {
    return adminInvoke('/admin/users/'+encodeURIComponent(userId)+'/status', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({disabled})});
  }

  async function member() {
    let me;
    try { me = await apiCall('/me'); }
    catch(e) { lock('Phiên đăng nhập đã hết hạn. Hãy tải lại trang và đăng nhập.'); throw e; }
    if(api.cacheId && !api.cacheId.endsWith('_'+me.id)) {
      lock('Tài khoản đã thay đổi. Tải lại trang để mở dữ liệu đúng tài khoản.');
      throw new Error('Tài khoản đã thay đổi; cần tải lại trang');
    }
    CURRENT_USER={code:me.login_id,name:me.display_name || me.login_id,admin:me.role==='admin'};
    accessGranted=true;
    if(started) applyUserUI();
    return me;
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
      const me=await member();
      let host=''; try { host=new URL(config.apiBaseUrl).hostname; } catch {}
      api.cacheId = host+'_'+me.id;
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
      if(hadCache) {
        $('#appShell').hidden=false; $('#loginOverlay').style.display='none';
        $('#loginPass').value=''; applyUserUI(); renderUsers();
        sync(false,true);
      } else {
        await sync(false,true);
        if(!accessGranted) return;
        $('#appShell').hidden=false; $('#loginOverlay').style.display='none';
        $('#loginPass').value=''; applyUserUI(); renderUsers();
      }
      scheduleBackgroundPoll();
    } catch(error) { releaseLock?.(); $('#loginErr').textContent=error.message; }
    finally { starting=false; }
  }
  async function logout() {
    if(started && (pending().length || mediaPending) && !confirm('Còn thay đổi hoặc ảnh gốc chưa gửi. Bản dữ liệu chờ giữ trên máy cho tài khoản này; ảnh gốc đang tải có thể cần chọn lại. Đăng xuất?')) return;
    lock('Đang đăng xuất…'); started=false; clearTimeout(timer); clearTimeout(pollTimer);
    await saveChain.catch(()=>{});
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    location.reload();
  }
  async function backupMedia(file, meta) {
    if(!started || !file) return;
    if(trafficState().state==='PROTECTION') {
      pendingMedia.push({id:crypto.randomUUID(), file, meta:meta||null, size:file.size, createdAt:Date.now()});
      await persist();
      renderTrafficBadge();
      return;
    }
    mediaPending++;
    try { await uploadOriginal(file, file.name); }
    catch(error) { mediaErrors++; status('Ảnh gốc chưa được sao lưu: '+error.message+'. Giữ file gốc trên máy; ảnh nén vẫn có thể lưu trong Finding.',true); }
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
  clearOldLogEntries=()=>toast('Nhật ký máy chủ được giữ để truy vết.');
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
      toast('Đã nhập trên máy; theo dõi thanh Đồng bộ để xác nhận đã gửi lên máy chủ.');
    } catch(error) { toast('Không nhập được: '+error.message); }
  };
  clearAllData=async()=>{
    if(!CURRENT_USER?.admin || !confirm('Đánh dấu xoá toàn bộ Finding đang có? Tài khoản giữ nguyên. App sẽ tải bản sao lưu trước.')) return;
    await backupJson(); DELETED_IDS=FINDINGS.map(f=>({id:f.id,deletedAt:Date.now()})); FINDINGS=[];
    await persist(); schedule(); fullRerender();
  };
  const originalMail=renderMail;
  renderMail=()=>{ originalMail(); if(!CURRENT_USER?.admin) $$('[data-mailemail],[data-mailpic],#saveMailBtn').forEach(el=>el.disabled=true); };

  // Chrome/Edge only show their "Save password?" prompt for SPA logins (no real page
  // navigation on submit) when explicitly told via the Credential Management API.
  $('#cloudLoginForm').addEventListener('submit',async event=>{
    event.preventDefault();
    $('#loginBtn').disabled=true; $('#loginErr').textContent='Đang đăng nhập…';
    const raw=$('#loginUser').value.trim(), password=$('#loginPass').value;
    if(!raw || !password) { $('#loginErr').textContent='Nhập tên đăng nhập/email và mật khẩu.'; $('#loginBtn').disabled=false; return; }
    try {
      const res = await apiCall('/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({login_id:raw, password})});
      token = res.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch {}
      if(window.PasswordCredential) {
        navigator.credentials.store(new PasswordCredential({id:raw,password,name:raw})).catch(()=>{});
      }
      await start();
    } catch(error) { $('#loginErr').textContent=error.message; }
    finally { $('#loginBtn').disabled=false; }
  });
  if(window.PasswordCredential && navigator.credentials) {
    navigator.credentials.get({password:true,mediation:'optional'}).then(cred=>{
      if(cred && cred.type==='password' && !$('#loginUser').value) {
        $('#loginUser').value=cred.id; $('#loginPass').value=cred.password;
      }
    }).catch(()=>{});
  }
  $('#logoutBtn').onclick=event=>{event.preventDefault();logout();};
  $('#cloudSignOut').onclick=logout;
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
  // Another tab signing out (or in as a different account) clears/changes the token key —
  // reload so this tab re-bootstraps against the new state instead of running stale.
  window.addEventListener('storage', event=>{
    if(event.key===TOKEN_KEY && started) location.reload();
  });

  if(!config.apiBaseUrl) {
    $('#loginErr').textContent='Chưa cấu hình apiBaseUrl trong config.js.';
    $('#loginBtn').disabled=true; return;
  }
  try { token = localStorage.getItem(TOKEN_KEY) || null; } catch {}
  if(token) start();
})();
