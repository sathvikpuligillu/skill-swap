/* ========================================================
   SkillSwap — app.js  (Supabase Edition)
   All data stored in Supabase PostgreSQL.
   Session (userId) still kept in localStorage.
   ======================================================== */

// ─────────────────────────────────────────────
// 1. SUPABASE CLIENT
// ─────────────────────────────────────────────

const SUPABASE_URL = 'https://eerfbtpygdulfuyidyei.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVlcmZidHB5Z2R1bGZ1eWlkeWVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTgyNTIsImV4cCI6MjA4OTU5NDI1Mn0.BqzNK7ch7GDOVsi2tt__guuNXfObBZvsf5e17zVh1Bs';

if (!window.supabase) {
  console.error("Supabase not loaded");
  document.addEventListener('DOMContentLoaded', () => {
    const l = document.getElementById('initial-loader');
    if (l) l.style.display = 'none';
    const fallback = document.createElement('div');
    fallback.style.position = 'fixed'; fallback.style.inset = 0; fallback.style.display = 'flex'; fallback.style.flexDirection = 'column'; fallback.style.alignItems = 'center'; fallback.style.justifyContent = 'center'; fallback.style.background = '#fff'; fallback.style.color = '#333'; fallback.style.zIndex = 10000; fallback.style.padding = '20px'; fallback.style.textAlign = 'center';
    fallback.innerHTML = `<h3>Supabase SDK Failed to Load</h3><p style="margin-bottom:15px;color:#666;">The CDN library is blocked or unavailable.</p><button onclick="window.location.reload()" style="padding:10px 20px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">Refresh Page</button>`;
    document.body.appendChild(fallback);
  });
  // Mock bare minimum to prevent immediately crashing interpreter
  window.supabase = { createClient: () => ({ auth: { onAuthStateChange: ()=>{}, getSession: async ()=>({}), signInWithOAuth: async ()=>({}), getUser: async ()=>({}), signOut: async ()=>({}) }, from: ()=>({ select: ()=>({ eq: ()=>({ single: async ()=>({}), limit: async ()=>({}) }), or: ()=>({ limit: async ()=>({}) }) }), update: ()=>({ eq: async ()=>({}) }), insert: async ()=>({}), delete: ()=>({ eq: async ()=>({}) }) }), channel: ()=>({ on: ()=>({ subscribe: ()=>{} }) }) }) };
}

const { createClient } = window.supabase;
const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("Supabase initialized");

const fetchWithRetry = async (promiseFn, name, retries = 3, delay = 500) => {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await promiseFn();
      if (Array.isArray(res)) {
         const errObj = res.find(r => r && r.error && r.error.code !== 'PGRST116');
         if (errObj) throw errObj.error;
         return res;
      }
      if (res && res.error && res.error.code !== 'PGRST116') {
        throw res.error;
      }
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`[${name}] Attempt ${i + 1} failed:`, err.message || err);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return { data: null, error: lastErr || new Error(`${name} failed after retries`) };
};

// ─────────────────────────────────────────────
// 2. SESSION  (only userId stored locally)
// ─────────────────────────────────────────────

const SESSION_KEY = 'skillswap_session';
let currentUserId = null;
function getSession()      { return currentUserId; }
function setSession(id)    { currentUserId = id; }
function clearSession()    { currentUserId = null; }
function genId()           { return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ─────────────────────────────────────────────
// 3. PURE IN-MEMORY HELPERS
// ─────────────────────────────────────────────

function skillsFor(users, userId, type) {
  const u = users.find(x => x.id === userId);
  if (!u) return [];
  return type === 'teach' ? (u.skills_teach || []) : (u.skills_learn || []);
}

function matchScore(users, currentId, otherId) {
  const myTeach    = skillsFor(users, currentId, 'teach').map(s => s.toLowerCase());
  const myLearn    = skillsFor(users, currentId, 'learn').map(s => s.toLowerCase());
  const theirTeach = skillsFor(users, otherId,   'teach').map(s => s.toLowerCase());
  const theirLearn = skillsFor(users, otherId,   'learn').map(s => s.toLowerCase());
  return theirTeach.filter(s => myLearn.includes(s)).length
       + theirLearn.filter(s => myTeach.includes(s)).length;
}

function existingReq(requests, senderId, receiverId) {
  return requests.find(r =>
    r.sender_id === senderId && r.receiver_id === receiverId && r.status === 'pending'
  );
}

function isConnected(connections, uid1, uid2) {
  return connections.some(c =>
    (c.user1_id === uid1 && c.user2_id === uid2) ||
    (c.user1_id === uid2 && c.user2_id === uid1)
  );
}

function initials(name) {
  return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

function timeAgo(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─────────────────────────────────────────────
// 4. SUPABASE DB OPERATIONS
// ─────────────────────────────────────────────

/** One parallel fetch for Home / Explore renders */
async function fetchContext(userId) {
  console.log("Data fetch started... (Context fetch)");
  let usersRes = {data: []}, reqRes = {data: []}, connRes = {data: []};
  try {
    const res = await fetchWithRetry(() => Promise.all([
      supa.from('users').select('*'),
      supa.from('requests').select('*')
           .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`),
      supa.from('connections').select('*')
           .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    ]), "fetchContext tables");
    if (res.error) throw res.error;
    [usersRes, reqRes, connRes] = res;
  } catch (err) {
    console.warn("fetchContext partially failed. Loading empty initial UI state synchronously.", err.message);
  }
  
  console.log("Data fetch success / failed:", {usersRes}, {reqRes}, {connRes});
  
  return {
    users:       usersRes?.data  || [],
    skills:      usersRes?.data  || [],
    requests:    reqRes?.data    || [],
    connections: connRes?.data   || []
  };
}

async function dbInsertUser(user)        { const {error} = await supa.from('users').insert(user);       if (error) throw error; }
async function dbInsertSkills(rows)      { const {error} = await supa.from('skills').insert(rows);       if (error) throw error; }
async function dbInsertRequest(req) {
  if (!req.created_at) req.created_at = Date.now();
  const {error} = await supa.from('requests').insert(req);
  if (error) { console.error('Request insert error:', error.message, error.details, error.hint); throw error; }
}
async function dbInsertConnection(conn) {
  if (!conn.created_at) conn.created_at = Date.now();
  const {error} = await supa.from('connections').insert(conn);
  if (error) { console.error('Connection insert error:', error.message, error.details); throw error; }
}
async function dbUpdateRequest(id, st)   { const {error} = await supa.from('requests').update({status:st}).eq('id',id); if (error) throw error; }

// ─────────────────────────────────────────────
// 6. TOAST
// ─────────────────────────────────────────────

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ─────────────────────────────────────────────
// 7. ROUTER
// ─────────────────────────────────────────────

async function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name)?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.screen === name)
  );
  switch (name) {
    case 'home':        await renderHome();        break;
    case 'explore':     await renderExplore();     break;
    case 'requests':    await renderRequests();    break;
    case 'connections': await renderConnections(); break;
    case 'profile':     await renderProfile();     break;
  }
  await updateNavBadge();
}

async function updateNavBadge() {
  const userId = getSession();
  if (!userId) return;
  const { data } = await supa.from('requests')
    .select('id').eq('receiver_id', userId).eq('status', 'pending');
  const count = data?.length || 0;
  const badge = document.getElementById('requests-badge');
  if (badge) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.classList.toggle('show', count > 0);
  }
}

// ─────────────────────────────────────────────
// 8. SKILL CHIP INPUT
// ─────────────────────────────────────────────

function buildSkillInput(inputId, chipsId, type) {
  const input = document.getElementById(inputId);
  const chips = document.getElementById(chipsId);
  const skills = [];

  function renderChips() {
    chips.innerHTML = skills.map((s, i) => `
      <span class="chip chip-${type}">
        ${s}
        <button type="button" class="chip-btn" data-index="${i}" aria-label="Remove ${s}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </span>`).join('');
    chips.querySelectorAll('.chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        skills.splice(Number(btn.dataset.index), 1);
        renderChips();
      });
    });
  }

  function addSkill(val) {
    const clean = val.trim();
    if (!clean || skills.find(s => s.toLowerCase() === clean.toLowerCase())) return;
    skills.push(clean);
    renderChips();
    input.value = '';
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSkill(input.value); }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) addSkill(input.value); });
  const addBtn = input.nextElementSibling;
  if (addBtn?.tagName === 'BUTTON') addBtn.addEventListener('click', () => addSkill(input.value));

  return { getSkills: () => [...skills] };
}

// ─────────────────────────────────────────────
// 9. ONBOARDING
// ─────────────────────────────────────────────

let teachCtrl, learnCtrl;
let isOnboardingInit = false;

function initOnboarding() {
  if (isOnboardingInit) return;
  isOnboardingInit = true;
  
  teachCtrl = buildSkillInput('teach-input', 'teach-chips', 'teach');
  learnCtrl = buildSkillInput('learn-input',  'learn-chips',  'learn');
  document.getElementById('onboard-form').addEventListener('submit', handleOnboardSubmit);
  document.getElementById('add-teach').addEventListener('click', () =>
    document.getElementById('teach-input').dispatchEvent(new Event('blur'))
  );
  document.getElementById('add-learn').addEventListener('click', () =>
    document.getElementById('learn-input').dispatchEvent(new Event('blur'))
  );
}

async function handleOnboardSubmit(e) {
  e.preventDefault();
  let valid = true;

  const teachSkills = teachCtrl.getSkills();
  const learnSkills  = learnCtrl.getSkills();
  setFieldError('teach-error', !teachSkills.length, 'Add at least one skill you can teach');
  setFieldError('learn-error',  !learnSkills.length,  'Add at least one skill you want to learn');
  if (!teachSkills.length || !learnSkills.length) valid = false;

  const phone    = document.getElementById('phone-input').value.trim();
  const whatsapp = document.getElementById('whatsapp-input').value.trim();
  const linkedin = document.getElementById('linkedin-input').value.trim();
  const phoneRx  = /^\+?[0-9]{10,}$/;
  const phoneOk  = !phone    || phoneRx.test(phone.replace(/\s/g,''));
  const waOk     = !whatsapp || phoneRx.test(whatsapp.replace(/\s/g,''));
  const liOk     = !linkedin || linkedin.includes('linkedin.com/in/');

  setFieldError('phone-error',    phone    && !phoneOk, 'Must be numeric, can start with "+", min 10 digits');
  setFieldError('whatsapp-error', whatsapp && !waOk,    'Must be numeric, can start with "+", min 10 digits');
  setFieldError('linkedin-error', linkedin && !liOk,    'Must be a valid LinkedIn profile URL (linkedin.com/in/...)');
  if ((phone && !phoneOk) || (whatsapp && !waOk) || (linkedin && !liOk)) valid = false;

  const hasContact = (phone && phoneOk) || (whatsapp && waOk) || (linkedin && liOk);
  setFieldError('contact-error', !hasContact, 'Please provide at least one contact method');
  if (!hasContact) valid = false;
  if (!valid) return;

  const btn = document.getElementById('onboard-submit');
  btn.disabled = true; btn.textContent = 'Joining…';

  try {
    const userId = getSession();
    const payload = {
      phone_number: (phone && phoneOk) ? phone : null,
      whatsapp_number: (whatsapp && waOk) ? whatsapp : null,
      linkedin_url: (linkedin && liOk) ? linkedin : null,
      skills_teach: teachSkills,
      skills_learn: learnSkills
    };
    console.log("Saving onboarding data to users table:", payload);
    
    const { error: updateError } = await supa.from('users').update(payload).eq('id', userId);
    
    if (updateError) throw updateError;
    
    setSession(userId);
    document.getElementById('screen-onboarding').classList.remove('active');
    document.querySelector('.nav-bar').classList.add('visible');
    await showScreen('home');
    subscribeRealtime(userId);
  } catch (err) {
    console.error("Onboarding Submit Error:", err);
    const errMsg = err.message || err.details || JSON.stringify(err);
    showToast('Error saving data');
    
    // Visual debug
    const errDiv = document.createElement('div');
    errDiv.style.position = 'fixed'; errDiv.style.top = '10px'; errDiv.style.left = '10px'; errDiv.style.right = '10px'; errDiv.style.background = '#d9534f'; errDiv.style.color = 'white'; errDiv.style.padding = '15px'; errDiv.style.zIndex = 10000; errDiv.style.borderRadius = '5px'; errDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    errDiv.innerHTML = '<strong>Database Error:</strong><br/>' + errMsg;
    document.body.appendChild(errDiv);
    
    btn.disabled = false; btn.textContent = 'Join SkillSwap';
  }
}

function setFieldError(id, show, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('show', !!show);
  const inp = el.previousElementSibling;
  if (inp?.classList.contains('form-input')) inp.classList.toggle('error', !!show);
}

// ─────────────────────────────────────────────
// 10. USER CARD (pure render, no fetch)
// ─────────────────────────────────────────────

function userCard(u, currentUserId, allSkills, requests, connections, myTeach, myLearn) {
  const teach = skillsFor(allSkills, u.id, 'teach');
  const learn  = skillsFor(allSkills, u.id, 'learn');
  const connected   = isConnected(connections, currentUserId, u.id);
  const pending     = existingReq(requests, currentUserId, u.id);

  const canLearnFromThem = teach.filter(s => myLearn.includes(s.toLowerCase()));
  const canTeachThem     = learn.filter(s => myTeach.includes(s.toLowerCase()));

  const teachTags = teach.map(s =>
    `<span class="tag ${myLearn.includes(s.toLowerCase()) ? 'tag-match' : 'tag-teach'}">${s}</span>`
  ).join('');
  const learnTags = learn.map(s =>
    `<span class="tag ${myTeach.includes(s.toLowerCase()) ? 'tag-match' : 'tag-learn'}">${s}</span>`
  ).join('');

  let contextLine = '';
  if (canLearnFromThem.length && canTeachThem.length)
    contextLine = `<div class="card-context"><span>🎯</span> Teach ${canTeachThem[0]} · Learn ${canLearnFromThem[0]}</div>`;
  else if (canLearnFromThem.length)
    contextLine = `<div class="card-context"><span>✨</span> You can learn <strong>${canLearnFromThem[0]}</strong> from them</div>`;
  else if (canTeachThem.length)
    contextLine = `<div class="card-context"><span>💡</span> They match your teaching skills</div>`;

  const badge = u.score > 0
    ? `<span class="match-score">🎯 ${u.score} Skill Match${u.score > 1 ? 'es' : ''}</span>` : '';

  const myTeachStr = myTeach.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
  const myLearnStr = myLearn.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');

  // Button is always clickable — DB check happens inside sendRequest
  const actionBtn = connected
    ? `<button class="btn btn-ghost btn-sm" disabled>✓ Connected</button>`
    : pending
      ? `<button class="btn btn-secondary btn-sm btn-request"
            data-uid="${u.id}" data-name="${u.name}"
            data-teach="${myTeachStr}" data-learn="${myLearnStr}">↩ Swap Requested</button>`
      : `<button class="btn btn-primary btn-sm btn-request"
            data-uid="${u.id}" data-name="${u.name}"
            data-teach="${myTeachStr}" data-learn="${myLearnStr}">Request Skill Swap</button>`;

  return `
    <div class="user-card">
      <div class="user-card-header">
        <div class="avatar">${initials(u.name)}</div>
        <div><div class="user-name">${u.name}</div>${contextLine}</div>
        ${badge}
      </div>
      <div class="skill-section">
        <div class="skill-label">Teaches</div>
        <div class="skill-tags">${teachTags || '<span class="tag tag-neutral">—</span>'}</div>
      </div>
      <div class="skill-section" style="margin-top:12px">
        <div class="skill-label">Wants to Learn</div>
        <div class="skill-tags">${learnTags || '<span class="tag tag-neutral">—</span>'}</div>
      </div>
      <div class="card-actions">
        ${actionBtn}
        <button class="btn btn-ghost btn-sm btn-view-profile" data-uid="${u.id}">View Profile</button>
      </div>
    </div>`;
}

function bindCardActions(container) {
  container.querySelectorAll('.btn-request').forEach(btn => {
    btn.addEventListener('click', () =>
      openRequestModal(btn.dataset.uid, btn.dataset.name, btn.dataset.teach, btn.dataset.learn)
    );
  });
  container.querySelectorAll('.btn-view-profile').forEach(btn => {
    btn.addEventListener('click', () => openProfileModal(btn.dataset.uid));
  });
}

// ─────────────────────────────────────────────
// 11. HOME FEED
// ─────────────────────────────────────────────

async function renderHome() {
  const userId = getSession();
  const container = document.getElementById('home-feed');
  if (!container) return;
  container.innerHTML = loadingHTML();

  const { users, skills, requests, connections } = await fetchContext(userId);
  const others = users.filter(u => u.id !== userId);

  if (!others.length) {
    container.innerHTML = emptyState('🌱', 'No other users yet', 'Invite friends to join SkillSwap.');
    return;
  }

  const myTeach = skillsFor(skills, userId, 'teach').map(s => s.toLowerCase());
  const myLearn = skillsFor(skills, userId, 'learn').map(s => s.toLowerCase());

  const scored = others
    .map(u => ({ ...u, score: matchScore(skills, userId, u.id) }))
    .sort((a, b) => b.score - a.score);

  const matched = scored.filter(u => u.score > 0);
  const rest    = scored.filter(u => u.score === 0);

  let html = matched.map(u => userCard(u, userId, skills, requests, connections, myTeach, myLearn)).join('');
  if (rest.length) {
    if (matched.length) html += `<div class="section-divider">Other Users</div>`;
    html += rest.map(u => userCard(u, userId, skills, requests, connections, myTeach, myLearn)).join('');
  }

  container.innerHTML = html;
  bindCardActions(container);
}

// ─────────────────────────────────────────────
// 12. EXPLORE
// ─────────────────────────────────────────────

async function renderExplore(query = '') {
  const userId = getSession();
  const container = document.getElementById('explore-feed');
  if (!container) return;
  container.innerHTML = loadingHTML();

  const { users, skills, requests, connections } = await fetchContext(userId);
  const lq = query.toLowerCase();
  let others = users.filter(u => u.id !== userId);

  if (lq) {
    others = others.filter(u => {
      const uTeach = u.skills_teach || [];
      const uLearn = u.skills_learn || [];
      const uSkills = [...uTeach, ...uLearn].map(s => s.toLowerCase());
      return uSkills.some(s => s.includes(lq)) || (u.name && u.name.toLowerCase().includes(lq));
    });
  }

  if (!others.length) {
    container.innerHTML = emptyState('🔍', 'No results found', query ? `No users match "${query}".` : 'No other users yet.');
    return;
  }

  const myTeach = skillsFor(skills, userId, 'teach').map(s => s.toLowerCase());
  const myLearn = skillsFor(skills, userId, 'learn').map(s => s.toLowerCase());

  container.innerHTML = others
    .map(u => ({ ...u, score: matchScore(skills, userId, u.id) }))
    .map(u => userCard(u, userId, skills, requests, connections, myTeach, myLearn))
    .join('');
  bindCardActions(container);
}

// ─────────────────────────────────────────────
// 13. REQUESTS
// ─────────────────────────────────────────────

async function renderRequests() {
  const userId = getSession();
  const container = document.getElementById('requests-list');
  if (!container) return;
  container.innerHTML = loadingHTML();

  const [reqRes, usersRes] = await Promise.all([
    supa.from('requests').select('*').eq('receiver_id', userId).eq('status', 'pending'),
    supa.from('users').select('*')
  ]);
  const incoming = reqRes.data || [];
  const users    = usersRes.data || [];

  if (!incoming.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📬</div>
        <div class="empty-title">No requests yet</div>
        <div class="empty-desc">Start by connecting with someone on the Explore screen.</div>
        <div class="empty-cta"><button class="btn btn-primary btn-sm" id="goto-explore-btn">Explore Users</button></div>
      </div>`;
    document.getElementById('goto-explore-btn')?.addEventListener('click', () => showScreen('explore'));
    return;
  }

  container.innerHTML = incoming.map(r => {
    const sender = users.find(u => u.id === r.sender_id);
    if (!sender) return '';
    return `
      <div class="request-card">
        <div class="request-meta">
          <div class="avatar" style="width:36px;height:36px;font-size:0.85rem">${initials(sender.name)}</div>
          <div class="request-name">${sender.name}</div>
          <div class="request-time">${timeAgo(r.created_at)}</div>
        </div>
        <div class="request-message">"${r.message}"</div>
        <div class="request-actions">
          <button class="btn btn-success btn-sm btn-accept" data-rid="${r.id}" data-sid="${r.sender_id}" style="flex:1">Accept</button>
          <button class="btn btn-danger  btn-sm btn-reject" data-rid="${r.id}" style="flex:1">Decline</button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.btn-accept').forEach(btn =>
    btn.addEventListener('click', () => handleRequestAction(btn.dataset.rid, btn.dataset.sid, 'accepted'))
  );
  container.querySelectorAll('.btn-reject').forEach(btn =>
    btn.addEventListener('click', () => handleRequestAction(btn.dataset.rid, null, 'rejected'))
  );
}

async function handleRequestAction(requestId, senderId, status) {
  try {
    await dbUpdateRequest(requestId, status);
    if (status === 'accepted') {
      const userId = getSession();
      // Guard: don't create duplicate connection
      const { data: existing } = await supa.from('connections').select('id')
        .or(`and(user1_id.eq.${userId},user2_id.eq.${senderId}),and(user1_id.eq.${senderId},user2_id.eq.${userId})`)
        .limit(1);
      if (!existing?.length) {
        await dbInsertConnection({ id:genId(), user1_id:senderId, user2_id:userId, created_at:Date.now() });
      }
      showToast('Connection made! 🎉');
    } else {
      showToast('Request declined');
    }
    await renderRequests();
    await updateNavBadge();
  } catch (err) {
    console.error(err);
    showToast('Something went wrong. Try again.');
  }
}

// ─────────────────────────────────────────────
// 14. CONNECTIONS
// ─────────────────────────────────────────────

async function renderConnections() {
  const userId = getSession();
  const container = document.getElementById('connections-list');
  if (!container) return;
  container.innerHTML = loadingHTML();

  const [connRes, usersRes] = await Promise.all([
    supa.from('connections').select('*').or(`user1_id.eq.${userId},user2_id.eq.${userId}`),
    supa.from('users').select('*')
  ]);
  const conns  = connRes.data  || [];
  const users  = usersRes.data || [];
  const skills = usersRes.data || [];

  if (!conns.length) {
    container.innerHTML = emptyState('🤝', 'No connections yet', 'Accept a request to reveal contact details here.');
    return;
  }

  container.innerHTML = conns.map(c => {
    const otherId = c.user1_id === userId ? c.user2_id : c.user1_id;
    const other   = users.find(u => u.id === otherId);
    if (!other) return '';

    const teach = skillsFor(skills, otherId, 'teach');
    const learn  = skillsFor(skills, otherId, 'learn');

    const contacts = [];
    if (other.phone_number)
      contacts.push(`<div class="contact-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.04 1.19 2 2 0 012 .02h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 14.92z"/></svg><div><div class="contact-detail-label">Phone</div><div class="contact-detail-value"><a href="tel:${other.phone_number.replace(/\s/g,'')}">${other.phone_number}</a></div></div></div>`);
    if (other.whatsapp_number)
      contacts.push(`<div class="contact-detail" style="margin-top:8px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><div><div class="contact-detail-label">WhatsApp</div><div class="contact-detail-value"><a href="https://wa.me/${other.whatsapp_number.replace(/[^0-9]/g,'')}" target="_blank">${other.whatsapp_number}</a></div></div></div>`);
    if (other.linkedin_url)
      contacts.push(`<div class="contact-detail" style="margin-top:8px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg><div><div class="contact-detail-label">LinkedIn</div><div class="contact-detail-value"><a href="${other.linkedin_url}" target="_blank" style="color:var(--primary)">${other.linkedin_url.replace('https://','')}</a></div></div></div>`);

    return `
      <div class="connection-card">
        <div class="user-card-header" style="margin-bottom:12px">
          <div class="avatar">${initials(other.name)}</div>
          <div><div class="user-name">${other.name}</div></div>
        </div>
        <div class="skill-section">
          <div class="skill-label">Teaches</div>
          <div class="skill-tags">${teach.map(s=>`<span class="tag tag-teach">${s}</span>`).join('')||'—'}</div>
        </div>
        <div class="skill-section" style="margin-top:10px">
          <div class="skill-label">Wants to Learn</div>
          <div class="skill-tags">${learn.map(s=>`<span class="tag tag-learn">${s}</span>`).join('')||'—'}</div>
        </div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
          <div class="skill-label" style="margin-bottom:8px">Contact Details</div>
          ${contacts.join('')}
        </div>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────
// 15. MY PROFILE
// ─────────────────────────────────────────────

function preferredContactLabel(user) {
  const m = [];
  if (user.whatsapp_number) m.push('WhatsApp');
  if (user.linkedin_url)    m.push('LinkedIn');
  if (user.phone_number)    m.push('Phone');
  if (!m.length) return '';
  return `<div class="preferred-contact">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
    Preferred: ${m.slice(0,2).join(' or ')}
  </div>`;
}

async function renderProfile() {
  const userId = getSession();
  const el = document.getElementById('profile-content');
  if (!el) return;
  el.innerHTML = loadingHTML();

  const [userRes] = await Promise.all([
    supa.from('users').select('*').eq('id', userId).single()
  ]);
  const user   = userRes.data;
  const skills = [user];
  if (!user) return;

  const teach = skillsFor(skills, userId, 'teach');
  const learn  = skillsFor(skills, userId, 'learn');

  el.innerHTML = `
    <div class="profile-header">
      <div class="avatar avatar-lg">${initials(user.name)}</div>
      <div class="profile-name">${user.name}</div>
      <div class="profile-joined">Member since ${new Date(user.created_at).toLocaleDateString('en-US',{month:'long',year:'numeric'})}</div>
      ${preferredContactLabel(user)}
    </div>
    <div class="profile-section">
      <div class="profile-section-title">Skills I Teach</div>
      <div class="skill-tags">${teach.map(s=>`<span class="tag tag-teach">${s}</span>`).join('')||'<span class="tag tag-neutral">None added</span>'}</div>
    </div>
    <div class="profile-section">
      <div class="profile-section-title">Skills I Want to Learn</div>
      <div class="skill-tags">${learn.map(s=>`<span class="tag tag-learn">${s}</span>`).join('')||'<span class="tag tag-neutral">None added</span>'}</div>
    </div>
    <div class="profile-section">
      <div class="profile-section-title">Contact Information</div>
      ${user.phone_number    ? `<div class="contact-detail"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.04 1.19 2 2 0 012 .02h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 14.92z"/></svg><div><div class="contact-detail-label">Phone</div><div class="contact-detail-value"><a href="tel:${user.phone_number.replace(/\s/g,'')}">${user.phone_number}</a></div></div></div>` : ''}
      ${user.whatsapp_number ? `<div class="contact-detail" style="margin-top:8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><div><div class="contact-detail-label">WhatsApp</div><div class="contact-detail-value"><a href="https://wa.me/${user.whatsapp_number.replace(/[^0-9]/g,'')}" target="_blank">${user.whatsapp_number}</a></div></div></div>` : ''}
      ${user.linkedin_url    ? `<div class="contact-detail" style="margin-top:8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg><div><div class="contact-detail-label">LinkedIn</div><div class="contact-detail-value"><a href="${user.linkedin_url}" target="_blank" style="color:var(--primary)">${user.linkedin_url.replace('https://','')}</a></div></div></div>` : ''}
    </div>
    <div style="margin-top:4px">
      <button class="logout-btn" id="logout-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </button>
    </div>`;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await supa.auth.signOut();
  });
}

// ─────────────────────────────────────────────
// 16. REQUEST MODAL
// ─────────────────────────────────────────────

let currentReqTarget = null;

function openRequestModal(receiverId, receiverName, myTeachStr, myLearnStr) {
  currentReqTarget = { receiverId, receiverName };
  document.getElementById('modal-target-name').textContent = receiverName;
  document.getElementById('modal-msg-error').classList.remove('show');
  let prefill = '';
  if (myTeachStr && myLearnStr)
    prefill = `Hey! I can teach ${myTeachStr} and I'd love to learn ${myLearnStr}. Want to do a skill swap?`;
  else if (myTeachStr)
    prefill = `Hey! I can teach ${myTeachStr}. Want to do a skill swap?`;
  document.getElementById('request-message').value = prefill;
  document.getElementById('request-modal').classList.add('open');
}

function closeRequestModal() {
  document.getElementById('request-modal').classList.remove('open');
  currentReqTarget = null;
}

async function sendRequest() {
  const msg = document.getElementById('request-message').value.trim();
  if (!msg) { document.getElementById('modal-msg-error').classList.add('show'); return; }
  if (!currentReqTarget) return;
  const { receiverId, receiverName } = currentReqTarget;
  const userId = getSession();
  const sendBtn = document.getElementById('modal-send-btn');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  try {
    // Live DB check — never rely on cached state
    const { data: existing } = await supa.from('requests')
      .select('id')
      .eq('sender_id', userId)
      .eq('receiver_id', receiverId)
      .eq('status', 'pending')
      .limit(1);

    if (existing && existing.length > 0) {
      closeRequestModal();
      showToast(`Already sent! Waiting for ${receiverName}'s response.`);
      return;
    }

    await dbInsertRequest({
      id: genId(),
      sender_id: userId,
      receiver_id: receiverId,
      message: msg,
      status: 'pending'
    });
    closeRequestModal();
    showToast(`Request sent to ${receiverName}! 🚀`);
    const active = document.querySelector('.screen.active');
    if (active?.id === 'screen-home')    await renderHome();
    if (active?.id === 'screen-explore') await renderExplore();
  } catch (err) {
    console.error('sendRequest failed:', err);
    showToast(`Error: ${err.message || 'Could not send request. Try again.'}`);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send Request 🚀';
  }
}

// ─────────────────────────────────────────────
// 17. PROFILE MODAL (other user)
// ─────────────────────────────────────────────

async function openProfileModal(uid) {
  const userId = getSession();
  const [userRes, meRes, connRes, reqRes] = await Promise.all([
    supa.from('users').select('*').eq('id', uid).single(),
    supa.from('users').select('*').eq('id', userId).single(),
    supa.from('connections').select('id')
         .or(`and(user1_id.eq.${userId},user2_id.eq.${uid}),and(user1_id.eq.${uid},user2_id.eq.${userId})`).limit(1),
    supa.from('requests').select('id')
         .eq('sender_id', userId).eq('receiver_id', uid).eq('status','pending').limit(1)
  ]);

  const user     = userRes.data;
  const meUser   = meRes.data;
  const skills   = user ? [user] : [];
  const mySkills = meUser ? [meUser] : [];
  if (!user) return;

  const teach = skillsFor(skills, uid, 'teach');
  const learn  = skillsFor(skills, uid, 'learn');

  document.getElementById('profile-modal-body').innerHTML = `
    <div style="text-align:center;padding:8px 0 20px">
      <div class="avatar avatar-lg" style="margin:0 auto 12px">${initials(user.name)}</div>
      <div class="profile-name">${user.name}</div>
    </div>
    <div class="profile-section" style="margin-bottom:12px">
      <div class="profile-section-title">Teaches</div>
      <div class="skill-tags">${teach.map(s=>`<span class="tag tag-teach">${s}</span>`).join('')||'<span class="tag tag-neutral">—</span>'}</div>
    </div>
    <div class="profile-section">
      <div class="profile-section-title">Wants to Learn</div>
      <div class="skill-tags">${learn.map(s=>`<span class="tag tag-learn">${s}</span>`).join('')||'<span class="tag tag-neutral">—</span>'}</div>
    </div>`;

  const reqBtn = document.getElementById('profile-modal-request-btn');
  if (connRes.data?.length) {
    reqBtn.textContent = '✓ Connected'; reqBtn.disabled = true; reqBtn.className = 'btn btn-ghost btn-full';
  } else if (reqRes.data?.length) {
    reqBtn.textContent = 'Swap Requested'; reqBtn.disabled = true; reqBtn.className = 'btn btn-ghost btn-full';
  } else {
    reqBtn.textContent = 'Request Skill Swap'; reqBtn.disabled = false; reqBtn.className = 'btn btn-primary btn-full';
    reqBtn.onclick = () => {
      closeProfileModal();
      const myTeachStr = skillsFor(mySkills, userId, 'teach').join(', ');
      const myLearnStr = skillsFor(mySkills, userId, 'learn').join(', ');
      openRequestModal(uid, user.name, myTeachStr, myLearnStr);
    };
  }

  document.getElementById('profile-modal').classList.add('open');
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.remove('open');
}

// ─────────────────────────────────────────────
// 18. UTILITIES
// ─────────────────────────────────────────────

function loadingHTML() {
  return `<div class="empty-state" style="padding:40px 20px">
    <div style="width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.7s linear infinite;margin:0 auto 0"></div>
  </div>`;
}

function emptyState(icon, title, desc) {
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${title}</div>
    <div class="empty-desc">${desc}</div>
  </div>`;
}

// ─────────────────────────────────────────────
// 19. REAL-TIME SUBSCRIPTION
// ─────────────────────────────────────────────

function subscribeRealtime(userId) {
  supa.channel('requests-rt')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'requests', filter: `receiver_id=eq.${userId}` },
      async () => {
        await updateNavBadge();
        const active = document.querySelector('.screen.active');
        if (active?.id === 'screen-requests') await renderRequests();
      }
    )
    .subscribe();
}

// ─────────────────────────────────────────────
// 20. BOOT & AUTH STATE
// ─────────────────────────────────────────────

let hasLoadedApp = false;

function showLoader() {
  const l = document.getElementById('initial-loader');
  if (l) l.style.display = 'flex';
}

function hideLoader() {
  const l = document.getElementById('initial-loader');
  if (l) l.style.display = 'none';
}

// backwards compatibility for any lingering references
function hideInitialLoader() { hideLoader(); }

function showLoginScreen() {
  console.log("Showing login");
  clearSession();
  hasLoadedApp = false;
  hideLoader();
  document.querySelector('.nav-bar').classList.remove('visible');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-login').classList.add('active');
}

async function loadHomePage(user) {
  if (hasLoadedApp) return;
  hasLoadedApp = true;
  
  hideLoader();
  document.getElementById('screen-login').classList.remove('active');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-home').classList.add('active');
  document.querySelector('.nav-bar').classList.add('visible');
  
  const homeContainer = document.getElementById('home-feed');
  if (homeContainer) homeContainer.innerHTML = loadingHTML();

  const userId = user.id;
  setSession(userId);
  
  const selectRes = await fetchWithRetry(() => supa.from('users').select('id, skills_teach').eq('id', userId).single(), "users.select");
  let existingUser = selectRes.data;
  let selectErr = selectRes.error;
  
  if (selectErr && selectErr.code !== 'PGRST116') {
    existingUser = { id: userId, skills_teach: ['pending_network'] }; 
    selectErr = null;
  }
  
  if (!existingUser || (existingUser && (!existingUser.skills_teach || existingUser.skills_teach.length === 0))) {
    document.querySelector('.nav-bar').classList.remove('visible');
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-onboarding').classList.add('active');
    initOnboarding();
    
    let name = user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';
    let email = user.email;
    fetchWithRetry(() => supa.from('users').insert({ id: userId, name, email, created_at: Date.now() }), "users.insert")
       .catch(err => console.warn(err));
  } else {
    await showScreen('home');
    subscribeRealtime(userId);
  }
}

async function initializeApp(user) {
    console.log("Loading app");
    await loadHomePage(user);
}

async function startApp() {
    console.log("App starting");
    showLoader();

    // 5. Ensure loader always stops against completely hung fetch connections
    let fallbackTimeout = setTimeout(() => {
        console.log("Error loading app (Network Timeout)");
        hideLoader();
        showLoginScreen();
    }, 5000);

    try {
        const { data: { session } } = await supa.auth.getSession();
        clearTimeout(fallbackTimeout);

        if (!session || !session.user) {
            hideLoader();
            showLoginScreen();
            console.log("No session → showing login");
            return;
        }

        console.log("Session found:", session.user.id);

        try {
            await initializeApp(session.user);
        } catch (e) {
            console.log("Error loading app", e);
            showLoginScreen();
        }

        hideLoader();
    } catch (err) {
        clearTimeout(fallbackTimeout);
        console.log("Error loading app", err);
        hideLoader();
        showLoginScreen();
    }
}

// 6. DO NOT rely on onAuthStateChange for initial load, only subsequent auth events
supa.auth.onAuthStateChange(async (event, session) => {
  if (event === 'SIGNED_IN' && session && session.user) {
    if (!hasLoadedApp) {
      console.log("Session found");
      try {
        await initializeApp(session.user);
      } catch (e) {
        console.log("Error loading app", e);
        showLoginScreen();
      }
    }
  } else if (event === 'SIGNED_OUT') {
    console.log("No session");
    showLoginScreen();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  console.log("App DOM loaded.");
  
  const btnGoogle = document.getElementById('btn-login-google');
  if (btnGoogle) {
    btnGoogle.addEventListener('click', async () => {
      console.log("Auth function triggered");
      btnGoogle.disabled = true;
      btnGoogle.innerHTML = 'Connecting...';
      const { error } = await supa.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + window.location.pathname
        }
      });
      if (error) {
        console.error('Google login error:', error);
        btnGoogle.disabled = false;
        btnGoogle.innerHTML = 'Continue with Google';
        showToast('Login Failed');
      }
    });
  }

  // 2. ONLY call startApp()
  startApp();
});

document.addEventListener('DOMContentLoaded', async () => {
  // inject spinner keyframe
  const style = document.createElement('style');
  style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);

  // If auth is already resolved (rare but possible), doing nothing is fine.
  // We rely on onAuthStateChange to route us.

  // Nav clicks
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => showScreen(item.dataset.screen));
  });

  // Request modal
  document.getElementById('modal-close').addEventListener('click', closeRequestModal);
  document.getElementById('modal-send-btn').addEventListener('click', sendRequest);
  document.getElementById('request-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('request-modal')) closeRequestModal();
  });

  // Profile modal
  document.getElementById('profile-modal-close').addEventListener('click', closeProfileModal);
  document.getElementById('profile-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('profile-modal')) closeProfileModal();
  });

  // Explore search
  document.getElementById('explore-search').addEventListener('input', e => {
    renderExplore(e.target.value);
  });
});
