/**
 * core.js — الطبقة المشتركة: الاتصال بالخادم، الجلسة والصلاحيات، القوائم الثابتة، أدوات الواجهة
 */

// ── قوائم ثابتة ─────────────────────────────────────────
const LEVELS = ['ابتدائي', 'متوسط', 'ثانوي'];
const SPECIALTIES = ['رياضيات', 'علوم فيزيائية', 'علوم طبيعية', 'لغة عربية', 'لغة فرنسية', 'لغة إنجليزية',
  'تاريخ وجغرافيا', 'فلسفة', 'تربية بدنية', 'تربية إسلامية', 'إعلام آلي', 'تسيير واقتصاد', 'أمازيغية',
  'فنون', 'موسيقى', 'إدارة الثانويات', 'إدارة المتوسطات', 'إدارة المدارس الابتدائية',
  'التسيير المالي والمادي', 'هندسة ميكانيكية', 'تخصص آخر'];
const INSPECTOR_RANKS = ['مفتش مساعد', 'مفتش', 'مفتش أول', 'مفتش عام'];
const VISIT_TYPES = ['توجيهية', 'تثبيت', 'ترقية'];
const PENALTIES = ['لا شيء', 'إقتراح إنذار', 'إقتراح توبيخ', 'إقتراح تشجيع', 'إقتراح ترسيم'];
const VISIT_NOTES = ['العمل بالتوجيهات والتوصيات المقدمة', 'تثمين الجهد المبذول', 'تدارك النقائص المسجلة'];
const ROLE_LABELS = { admin: 'مدير النظام', inspector: 'مفتش', manager: 'مسيّر' };
const RESOURCES = ['visits', 'inspectors', 'institutions', 'missions'];
const ACTIONS = ['view', 'add', 'edit', 'delete'];
const RESOURCE_LABELS = { visits: 'الزيارات', inspectors: 'المفتشون', institutions: 'المؤسسات', missions: 'الأمر بمهمة' };
const ACTION_LABELS = { view: 'اطلاع', add: 'إضافة', edit: 'تعديل', delete: 'حذف' };
// الصلاحيات الافتراضية لكل دور (نفس القيم في Code.gs)
const ROLE_PRESETS = {
  inspector: { visits: ['view', 'add', 'edit', 'delete'], inspectors: ['view'], institutions: ['view'], missions: [] },
  manager: { visits: ['view'], inspectors: ['view'], institutions: ['view'], missions: [] },
  admin: { visits: ACTIONS.slice(), inspectors: ACTIONS.slice(), institutions: ACTIONS.slice(), missions: ACTIONS.slice() }
};

// ── الموسم الدراسي (يبدأ في سبتمبر) ─────────────────────
function currentSeasonStart() {
  const d = new Date();
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}
function seasonLabel(y) { return `${y} / ${Number(y) + 1}`; }

// ── الجلسة والصلاحيات ───────────────────────────────────
const SESSION_KEY = 'visits_session';
function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function setSession(s) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

function can(res, act) {
  const s = getSession();
  if (!s) return false;
  return s.user.role === 'admin' || ((s.user.perms || {})[res] || []).includes(act);
}

// أول صفحة يملك المستخدم حق الاطلاع عليها
function homePage(u) {
  if (u.role === 'admin') return 'dashboard.html';
  const order = [['visits', 'visit.html'], ['inspectors', 'inspectors.html'], ['institutions', 'institutions.html'], ['missions', 'mission.html']];
  for (const [r, p] of order) if (((u.perms || {})[r] || []).includes('view')) return p;
  return 'visit.html';
}

function requireAuth(roles, need) {
  const s = getSession();
  if (!s) { location.href = 'index.html'; return null; }
  const u = s.user;
  let ok = !(roles && !roles.includes(u.role));
  if (ok && need) ok = can(need[0], need[1]);
  if (!ok) {
    const target = homePage(u), here = location.pathname.split('/').pop() || 'index.html';
    if (here === target) {
      document.body.innerHTML = '<div class="container"><div class="card"><p style="margin-bottom:1rem;">ليست لديك صلاحية لعرض هذه الصفحة. تواصل مع مدير النظام.</p><button class="btn btn-danger" onclick="logout()">خروج</button></div></div>';
    } else location.href = target;
    return null;
  }
  return u;
}

async function logout() {
  try { await api('logout'); } catch (e) { /* تجاهل */ }
  clearSession();
  location.href = 'index.html';
}

async function changeMyPassword() {
  const oldPassword = prompt('كلمة المرور الحالية:');
  if (!oldPassword) return;
  const newPassword = prompt('كلمة المرور الجديدة (6 أحرف على الأقل):');
  if (!newPassword) return;
  try {
    showLoader();
    await api('changePassword', { oldPassword, newPassword });
    showSuccess('تم تغيير كلمة المرور');
  } catch (e) { showError(e.message); }
  hideLoader();
}

// ── المديرية (tenant): من الرابط ?d=  ثم config.js ثم المحفوظ ──
function getTenant() {
  const q = (new URLSearchParams(location.search).get('d') || '').toLowerCase();
  const prev = localStorage.getItem('visits_tenant') || '';
  if (q) {
    if (q !== prev) clearSession();
    localStorage.setItem('visits_tenant', q);
    return q;
  }
  return CONFIG.TENANT || prev;
}

// ── الاتصال بالخادم ─────────────────────────────────────
async function api(action, payload = {}) {
  if (!CONFIG.API_URL || CONFIG.API_URL.startsWith('PASTE')) {
    throw new Error('لم يُضبط رابط الخادم في config.js');
  }
  const s = getSession();
  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // يتجنب طلب preflight
      body: JSON.stringify({ action, token: s && s.token, tenant: getTenant(), ...payload })
    });
  } catch (e) { throw new Error('تعذر الاتصال بالخادم. تحقق من الإنترنت'); }
  const j = await res.json();
  if (!j.ok) {
    if (j.code === 'AUTH') {
      sessionStorage.setItem('visits_msg', j.error || '');
      clearSession(); location.href = 'index.html';
    }
    throw new Error(j.error || 'حدث خطأ');
  }
  return j.data;
}

// soft=true: الأقسام التي لا يملك المستخدم صلاحية الاطلاع عليها تُرجَع فارغة بدل الخطأ
async function listMany(sheets, soft) {
  const d = await api('listMany', { sheets, soft: !!soft });
  if (d._me) { const s = getSession(); if (s) { s.user = d._me; setSession(s); } delete d._me; } // تحديث الصلاحيات
  return d;
}

// ── أدوات الواجهة ───────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showToast(msg, type = 'success', ms = 3500) {
  let c = document.getElementById('toastContainer');
  if (!c) { c = document.createElement('div'); c.id = 'toastContainer'; c.className = 'toast-container'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; c.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const showSuccess = m => showToast('✅ ' + m, 'success');
const showError = m => showToast('❌ ' + m, 'error', 5000);
function showLoader() { const e = document.getElementById('loaderOverlay'); if (e) e.style.display = 'flex'; }
function hideLoader() { const e = document.getElementById('loaderOverlay'); if (e) e.style.display = 'none'; }

function fillSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  if (placeholder !== undefined) sel.add(new Option(placeholder, ''));
  items.forEach(i => { const [v, l] = Array.isArray(i) ? i : [i, i]; sel.add(new Option(l, v)); });
}
function setSelectValue(sel, val) {
  if (val && ![...sel.options].some(o => o.value === val)) sel.add(new Option(val, val));
  sel.value = val || '';
}

// شريط التنقل حسب الصلاحيات؛ اسم المفتش يظهر بارزًا عند الدخول بحسابه
function renderNav() {
  const s = getSession(); if (!s) return;
  const u = s.user, admin = u.role === 'admin', me = u.inspector;
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = [
    admin && ['dashboard.html', '⚙️ لوحة التحكم'],
    can('inspectors', 'view') && ['inspectors.html', '🔍 المفتشون'],
    can('institutions', 'view') && ['institutions.html', '🏢 المؤسسات'],
    can('visits', 'view') && ['visit.html', me ? '📋 زياراتي' : '📋 الزيارات'],
    can('visits', 'view') && ['reports.html', me ? '📊 تقرير مقاطعتي' : '📊 التقارير'],
    can('missions', 'view') && ['mission.html', '📜 الأمر بالمهمة'],
    admin && ['settings.html', '🛠️ الإعدادات']
  ].filter(Boolean);
  const el = document.getElementById('nav');
  if (!el) return;
  el.innerHTML = `
    <nav class="navbar">
      <div class="brand"><span>🏫</span> ${esc(CONFIG.APP_NAME)}</div>
      <div class="nav-links">
        <span class="user-info">${me ? '👤 ' : 'مرحباً '}<strong style="${me ? 'font-size:1.15rem;' : ''}">${esc(u.name)}</strong>
          <span class="badge badge-${esc(u.role)}">${esc(ROLE_LABELS[u.role])}</span>${me ? ` <span class="badge badge-manager">${esc(me.stage)}</span>` : ''}</span>
        ${links.map(([h, t]) => `<a href="${h}" class="btn btn-sm ${h === here ? 'btn-accent' : 'btn-ghost'}">${t}</a>`).join('')}
        <button class="btn btn-ghost btn-sm" onclick="changeMyPassword()" title="تغيير كلمة المرور">🔑</button>
        <button class="btn btn-danger btn-sm" onclick="logout()">خروج 🚪</button>
      </div>
    </nav>`;
}

// تحقق + شريط: يُستدعى في بداية كل صفحة داخلية. roles: أدوار مسموحة، need: [قسم، إجراء]
function initPage(roles, need) {
  const u = requireAuth(roles, need);
  if (u) renderNav();
  return u;
}
