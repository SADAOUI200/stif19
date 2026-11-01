/**
 * نظام إدارة الزيارات التفتيشية – الخلفية الموحدة (Google Apps Script)
 * ملف واحد يخدم كل الأوراق: users, settings, municipalities,
 * inspectors, institutions, visits, missions
 *
 * طريقة التشغيل: انظر DEPLOY.md
 *  1) غيّر كلمة مرور المدير الأولية أدناه
 *  2) شغّل الدالة setup() مرة واحدة
 *  3) Deploy > New deployment > Web app (Execute as: Me, Access: Anyone)
 */

// ═══ إعدادات أولية (غيّرها قبل تشغيل setup) ═══
const INITIAL_ADMIN = { username: 'admin', password: 'ChangeMe#2026', name: 'مدير النظام' };
const TOKEN_TTL = 21600; // مدة الجلسة بالثواني (6 ساعات)

// ═══ مخطط الأعمدة: [مفتاح داخلي، عنوان العمود في الشيت] ═══
const SCHEMA = {
  users: [['id','المعرف'],['username','اسم المستخدم'],['name','الاسم الكامل'],['role','الدور'],['salt','salt'],['hash','hash'],['createdAt','تاريخ الإنشاء']],
  settings: [['key','المفتاح'],['value','القيمة']],
  municipalities: [['id','المعرف'],['name','البلدية']],
  inspectors: [['id','المعرف'],['name','الاسم الكامل'],['specialty','التخصص'],['stage','المرحلة'],['rank','الرتبة الوظيفية'],['phone','رقم الهاتف'],['createdAt','تاريخ الإنشاء']],
  institutions: [['id','المعرف'],['municipality','البلدية'],['name','اسم المؤسسة'],['stage','المرحلة'],['director','مدير المؤسسة'],['finManager','المسيّر المالي'],['createdAt','تاريخ الإنشاء']],
  visits: [['id','المعرف'],['createdAt','التوقيت'],['inspector','اسم المفتش'],['specialty','التخصص'],['stage','المرحلة'],['municipality','البلدية'],['institution','المؤسسة'],['visitee','اسم المعني بالزيارة'],['rank','الرتبة'],['grade','الدرجة'],['visitType','نوع الزيارة'],['visitDate','تاريخ الزيارة'],['score','النقطة'],['penalty','العقوبات'],['note','الملاحظة'],['season','الموسم الدراسي'],['createdBy','سُجّلت بواسطة']],
  missions: [['id','المعرف'],['createdAt','التوقيت'],['number','الرقم التسلسلي'],['stage','المرحلة'],['inspector','الاسم واللقب'],['residence','الإقامة الإدارية'],['place','مكان الملتقى'],['departDate','تاريخ الذهاب'],['returnDate','تاريخ العودة'],['subject','موضوع الملتقى'],['note','الملاحظة']]
};
const PREFIX = { users:'USR', municipalities:'MUN', inspectors:'INS', institutions:'INST', visits:'VIS', missions:'MIS' };
const REQUIRED = {
  users:['username','name','role'], municipalities:['name'], inspectors:['name','stage'],
  institutions:['name','stage','municipality'], visits:['inspector','institution','visitee','visitDate','stage'],
  missions:['number','stage','inspector','departDate','returnDate']
};
const ALL = ['admin','inspector','manager'];
const PERMS = {
  users:{r:['admin'],w:['admin']}, municipalities:{r:ALL,w:['admin']}, inspectors:{r:ALL,w:['admin']},
  institutions:{r:ALL,w:['admin']}, visits:{r:ALL,w:['admin','inspector']}, missions:{r:['admin'],w:['admin']}
};
const ROLES = ['admin','inspector','manager'];
const SETTING_KEYS = ['directorate'];

// ═══ نقاط الدخول ═══
function doGet() { return json_({ ok: true, data: 'API is running' }); }

function doPost(e) {
  let out;
  try {
    out = route_(JSON.parse(e.postData.contents));
  } catch (ex) {
    out = { ok: false, error: String(ex.message || ex) };
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
const ok_ = d => ({ ok: true, data: d });
const err_ = m => ({ ok: false, error: m });

function route_(r) {
  if (r.action === 'publicInfo') return ok_({ directorate: getSettings_().directorate || '' });
  if (r.action === 'login') return login_(r);

  const user = session_(r.token);
  if (!user) return { ok: false, code: 'AUTH', error: 'انتهت الجلسة، أعد تسجيل الدخول' };

  switch (r.action) {
    case 'logout': CacheService.getScriptCache().remove('tok_' + r.token); return ok_(true);
    case 'listMany': return listMany_(user, r.sheets || []);
    case 'changePassword': return locked_(() => changePassword_(user, r));
    case 'setSettings': return locked_(() => setSettings_(user, r.data || {}));
    case 'insert': case 'update': case 'delete': case 'bulkInsert':
      return locked_(() => write_(user, r));
  }
  return err_('إجراء غير معروف');
}

function locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ═══ المصادقة ═══
function hash_(salt, pw) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + pw, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function login_(r) {
  const uname = String(r.username || '').trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const fkey = 'fail_' + uname;
  const fails = Number(cache.get(fkey) || 0);
  if (fails >= 5) return err_('محاولات كثيرة خاطئة. أعد المحاولة بعد 10 دقائق');
  const u = readAll_('users').find(x => x.username.toLowerCase() === uname);
  if (!u || hash_(u.salt, String(r.password || '')) !== u.hash) {
    cache.put(fkey, String(fails + 1), 600);
    return err_('اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  cache.remove(fkey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  const info = { id: u.id, username: u.username, name: u.name, role: u.role };
  cache.put('tok_' + token, JSON.stringify(info), TOKEN_TTL);
  return ok_({ token: token, user: info });
}

function session_(token) {
  if (!token) return null;
  const v = CacheService.getScriptCache().get('tok_' + token);
  return v ? JSON.parse(v) : null;
}

function can_(user, sheet, mode) {
  const p = PERMS[sheet];
  return !!p && p[mode].indexOf(user.role) > -1;
}

function changePassword_(user, r) {
  const sh = getSheet_('users');
  const row = findRow_(sh, user.id);
  if (row < 0) return err_('الحساب غير موجود');
  const u = rowToObj_('users', sh.getRange(row, 1, 1, SCHEMA.users.length).getValues()[0]);
  if (hash_(u.salt, String(r.oldPassword || '')) !== u.hash) return err_('كلمة المرور الحالية غير صحيحة');
  if (String(r.newPassword || '').length < 6) return err_('كلمة المرور الجديدة قصيرة (6 أحرف على الأقل)');
  u.salt = Utilities.getUuid();
  u.hash = hash_(u.salt, String(r.newPassword));
  writeRow_(sh, row, 'users', u);
  return ok_(true);
}

// ═══ القراءة ═══
function listMany_(user, sheets) {
  const out = {};
  for (const name of sheets) {
    if (name === 'settings') { out.settings = getSettings_(); continue; }
    if (!SCHEMA[name]) return err_('ورقة غير معروفة: ' + name);
    if (!can_(user, name, 'r')) return err_('ليست لديك صلاحية قراءة: ' + name);
    out[name] = readAll_(name).map(o => {
      if (name === 'users') { delete o.salt; delete o.hash; }
      return o;
    });
  }
  return ok_(out);
}

// ═══ الكتابة ═══
function write_(user, r) {
  const name = r.sheet;
  if (!SCHEMA[name] || name === 'settings') return err_('ورقة غير معروفة');
  if (!can_(user, name, 'w')) return err_('ليست لديك صلاحية لهذا الإجراء');
  const sh = getSheet_(name);

  if (r.action === 'bulkInsert') {
    if (name !== 'municipalities') return err_('الإدراج الجماعي متاح للبلديات فقط');
    const existing = readAll_(name).map(x => norm_(x.name));
    let added = 0;
    (r.rows || []).slice(0, 300).forEach(n => {
      const v = clean_(n);
      if (!v || existing.indexOf(norm_(v)) > -1) return;
      appendRow_(sh, name, { id: newId_(name), name: v });
      existing.push(norm_(v)); added++;
    });
    return ok_({ added: added });
  }

  if (r.action === 'insert') {
    const rec = pick_(name, r.data || {});
    for (const k of REQUIRED[name] || []) if (!rec[k]) return err_('حقل مطلوب ناقص: ' + k);
    const dup = duplicate_(name, rec, null);
    if (dup) return err_(dup);
    rec.id = newId_(name);
    if (rec.createdAt === undefined) rec.createdAt = new Date().toISOString();
    if (name === 'visits') rec.createdBy = user.username;
    if (name === 'users') {
      const e = prepUser_(rec, r.data.password, true);
      if (e) return err_(e);
    }
    appendRow_(sh, name, rec);
    return ok_({ id: rec.id });
  }

  const row = findRow_(sh, r.id);
  if (row < 0) return err_('السجل غير موجود');
  const cur = rowToObj_(name, sh.getRange(row, 1, 1, SCHEMA[name].length).getValues()[0]);

  if (r.action === 'delete') {
    if (name === 'users' && cur.id === user.id) return err_('لا يمكنك حذف حسابك');
    sh.deleteRow(row);
    return ok_(true);
  }

  // update
  const upd = pick_(name, r.data || {});
  ['id', 'createdAt', 'createdBy', 'salt', 'hash'].forEach(k => delete upd[k]);
  const rec = Object.assign({}, cur, upd);
  for (const k of REQUIRED[name] || []) if (!rec[k]) return err_('حقل مطلوب ناقص: ' + k);
  const dup = duplicate_(name, rec, cur.id);
  if (dup) return err_(dup);
  if (name === 'users') {
    if (cur.id === user.id && rec.role !== 'admin') return err_('لا يمكنك إزالة صلاحية المدير عن حسابك');
    const pw = (r.data || {}).password;
    if (pw) { const e = prepUser_(rec, pw, false); if (e) return err_(e); }
    if (ROLES.indexOf(rec.role) < 0) return err_('دور غير صالح');
  }
  writeRow_(sh, row, name, rec);
  return ok_(true);
}

function prepUser_(rec, password, isNew) {
  if (ROLES.indexOf(rec.role) < 0) return 'دور غير صالح';
  if (String(password || '').length < 6) return 'كلمة المرور قصيرة (6 أحرف على الأقل)';
  rec.salt = Utilities.getUuid();
  rec.hash = hash_(rec.salt, String(password));
  return null;
}

function duplicate_(name, rec, selfId) {
  const rows = readAll_(name).filter(x => x.id !== selfId);
  if (name === 'visits' && rows.some(x => norm_(x.visitee) === norm_(rec.visitee) && x.visitDate === rec.visitDate))
    return 'تم تسجيل زيارة لهذا الشخص في هذا التاريخ مسبقًا';
  if (name === 'users' && rows.some(x => x.username.toLowerCase() === String(rec.username).toLowerCase()))
    return 'اسم المستخدم موجود مسبقًا';
  if (name === 'municipalities' && rows.some(x => norm_(x.name) === norm_(rec.name)))
    return 'هذه البلدية مسجلة مسبقًا';
  return null;
}

// ═══ الإعدادات ═══
function getSettings_() {
  const o = {};
  readAll_('settings').forEach(x => { o[x.key] = x.value; });
  return o;
}

function setSettings_(user, data) {
  if (user.role !== 'admin') return err_('ليست لديك صلاحية');
  const sh = getSheet_('settings');
  SETTING_KEYS.forEach(k => {
    if (data[k] === undefined) return;
    const v = clean_(data[k]);
    const rows = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    const i = rows.findIndex(x => x[0] === k);
    if (i > -1) sh.getRange(i + 2, 2).setValue(v);
    else appendRow_(sh, 'settings', { key: k, value: v });
  });
  return ok_(getSettings_());
}

// ═══ أدوات الشيت ═══
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || createSheet_(ss, name);
}

function createSheet_(ss, name) {
  const cols = SCHEMA[name];
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setValues([cols.map(c => c[1])])
    .setFontWeight('bold').setBackground('#1a56a0').setFontColor('#ffffff');
  sh.getRange(2, 1, sh.getMaxRows() - 1, cols.length).setNumberFormat('@'); // نص صريح: يمنع تحويل التواريخ والأرقام
  sh.setFrozenRows(1);
  sh.setRightToLeft(true);
  return sh;
}

function cell_(v) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v == null ? '' : v);
}

function rowToObj_(name, row) {
  const o = {};
  SCHEMA[name].forEach((c, i) => { o[c[0]] = cell_(row[i]); });
  return o;
}

function readAll_(name) {
  const sh = getSheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SCHEMA[name].length).getValues()
    .filter(r => r[0] !== '').map(r => rowToObj_(name, r));
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2 || !id) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function appendRow_(sh, name, rec) {
  writeRow_(sh, sh.getLastRow() + 1, name, rec);
}

function writeRow_(sh, rowNum, name, rec) {
  const cols = SCHEMA[name];
  sh.getRange(rowNum, 1, 1, cols.length).setNumberFormat('@')
    .setValues([cols.map(c => rec[c[0]] === undefined ? '' : String(rec[c[0]]))]);
}

function pick_(name, data) {
  const o = {};
  SCHEMA[name].forEach(c => { if (data[c[0]] !== undefined) o[c[0]] = clean_(data[c[0]]); });
  return o;
}

function clean_(v) {
  return String(v == null ? '' : v).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}
function norm_(v) { return clean_(v).normalize('NFC'); }
function newId_(name) { return PREFIX[name] + '-' + Utilities.getUuid().slice(0, 8).toUpperCase(); }

// ═══ التهيئة: شغّلها مرة واحدة من المحرر ═══
function setup() {
  Object.keys(SCHEMA).forEach(getSheet_);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Feuille 1') || ss.getSheetByName('ورقة1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (readAll_('users').length === 0) {
    const salt = Utilities.getUuid();
    appendRow_(getSheet_('users'), 'users', {
      id: newId_('users'), username: INITIAL_ADMIN.username, name: INITIAL_ADMIN.name, role: 'admin',
      salt: salt, hash: hash_(salt, INITIAL_ADMIN.password), createdAt: new Date().toISOString()
    });
    Logger.log('تم إنشاء حساب المدير: ' + INITIAL_ADMIN.username + ' — غيّر كلمة المرور بعد أول دخول');
  }
  Logger.log('اكتملت التهيئة ✔');
}
