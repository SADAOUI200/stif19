/**
 * core.js — الطبقة المشتركة: الاتصال بالخادم، الجلسة، القوائم الثابتة، أدوات الواجهة
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

// ── الموسم الدراسي (يبدأ في سبتمبر) ─────────────────────
function currentSeasonStart() {
  const d = new Date();
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}
function seasonLabel(y) { return `${y} / ${Number(y) + 1}`; }

// ── الجلسة ──────────────────────────────────────────────
const SESSION_KEY = 'visits_session';
function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function setSession(s) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }
function homePage(role) { return role === 'admin' ? 'dashboard.html' : 'visit.html'; }

function requireAuth(roles) {
  const s = getSession();
  if (!s) { location.href = 'index.html'; return null; }
  if (roles && !roles.includes(s.user.role)) { location.href = homePage(s.user.role); return null; }
  return s.user;
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
    if (j.code === 'AUTH') { clearSession(); location.href = 'index.html'; }
    throw new Error(j.error || 'حدث خطأ');
  }
  return j.data;
}
const listMany = sheets => api('listMany', { sheets });

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

// شريط التنقل حسب الدور
function renderNav() {
  const s = getSession(); if (!s) return;
  const u = s.user, admin = u.role === 'admin';
  const here = location.pathname.split('/').pop() || 'index.html';
  const links = [
    admin && ['dashboard.html', '⚙️ لوحة التحكم'],
    admin && ['inspectors.html', '🔍 المفتشون'],
    admin && ['institutions.html', '🏢 المؤسسات'],
    ['visit.html', '📋 الزيارات'],
    ['reports.html', '📊 التقارير'],
    admin && ['mission.html', '📜 الأمر بالمهمة'],
    admin && ['settings.html', '🛠️ الإعدادات']
  ].filter(Boolean);
  const el = document.getElementById('nav');
  if (!el) return;
  el.innerHTML = `
    <nav class="navbar">
      <div class="brand"><span>🏫</span> ${esc(CONFIG.APP_NAME)}</div>
      <div class="nav-links">
        <span class="user-info">مرحباً <strong>${esc(u.name)}</strong> <span class="badge badge-${esc(u.role)}">${esc(ROLE_LABELS[u.role])}</span></span>
        ${links.map(([h, t]) => `<a href="${h}" class="btn btn-sm ${h === here ? 'btn-accent' : 'btn-ghost'}">${t}</a>`).join('')}
        <button class="btn btn-ghost btn-sm" onclick="changeMyPassword()">🔑</button>
        <button class="btn btn-danger btn-sm" onclick="logout()">خروج 🚪</button>
      </div>
    </nav>`;
}

// تحقق + شريط + مؤشر تحميل: يُستدعى في بداية كل صفحة داخلية
function initPage(roles) {
  const u = requireAuth(roles);
  if (u) renderNav();
  return u;
}
