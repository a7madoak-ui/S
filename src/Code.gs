/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  نبض المدارس (Nabd) — «متابعة سير العملية التعليمية»
 *  Server code for Google Apps Script (V8 runtime) — version 1.2.0
 *
 *  This is a single file on purpose, so a supervisor can paste it into the
 *  Apps Script editor without juggling many files.
 *
 *  Sections
 *    1. Constants & defaults
 *    2. Pure helpers: strings, numbers, cells, ids, dates & times
 *    3. Domain logic (pure — takes plain data, no Google services):
 *       fields & presets, answer validation, derived metrics, edit rules,
 *       bulk school parsing, day dashboard, range statistics
 *    4. Platform glue: errors, lock, properties, cache, config
 *    5. Storage: sheets, «ابدأ هنا», schools, reports, dynamic columns, log
 *    6. Photos (Drive — only files and the folder this app creates)
 *    7. Bootstrap & routing: bootstrap_, doGet, include
 *    8. School-side API (authorised by the school's private token)
 *    9. Auth & setup API (OTP by email, sessions)
 *   10. Supervisor API: dashboard, review, reports, statistics
 *   11. Supervisor API: schools
 *   12. Supervisor API: form & settings (+ digest trigger)
 *   13. Emails (OTP, daily digest) & the dailyDigest trigger
 *   14. Spreadsheet menu (onOpen + menu handlers)
 *
 *  Conventions
 *    • Functions ending with "_" are private: google.script.run cannot call them.
 *    • api_* functions never return Date objects (dates are 'yyyy-MM-dd',
 *      times 'HH:mm', timestamps 'yyyy-MM-dd HH:mm:ss', all in Asia/Riyadh).
 *    • Every cell is read defensively (cellStr_/toBool_/toInt_) and every
 *      string written to a sheet passes through safeCell_.
 *    • Every write path runs inside withLock_.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants & defaults
// ═══════════════════════════════════════════════════════════════════════════

const APP_NAME = 'نبض المدارس';
const DEFAULT_SYSTEM_TITLE = 'متابعة سير العملية التعليمية';
const APP_VERSION = '1.2.0';
const TZ = 'Asia/Riyadh';

const SH_SCHOOLS = 'المدارس';
const SH_REPORTS = 'التقارير';
const SH_LOG = 'السجل';
const SH_START = 'ابدأ هنا';

const PHOTOS_FOLDER_NAME = 'نبض المدارس — شواهد المتابعة';
const PREVIEW_TOKEN = '__preview';
const BRAND_COLOR = '#0E7C66';
const DEFAULT_SUPERVISOR_TITLE = 'المشرف التربوي';

const LIMITS_ = Object.freeze({
  otpTtlSec: 600,            // OTP valid for 10 minutes
  otpCooldownSec: 60,        // one code per minute
  otpPerHour: 6,
  otpPer6h: 10,              // protects the owner's daily Gmail quota (~100 emails)
  otpTries: 5,
  pinWindowSec: 900,         // 15 minutes
  pinTries: 5,
  submitsPerDay: 30,
  uploadsPerDay: 40,
  counterTtlSec: 21600,      // CacheService maximum (6 h)
  photoMaxBytes: 3 * 1024 * 1024,
  sessionDays: 30,
  sessionSlideMs: 12 * 3600 * 1000,
  sessionsMax: 15,
  logTrimAt: 2200,
  logKeep: 2000,
  holidaysMax: 200,
  rangeMaxDays: 190,
  bulkMaxLines: 200,
  fieldsMax: 25,
  propChunkBytes: 8000,      // Script Properties: 9 KB per value
  answersJsonMax: 45000,     // a Sheets cell holds 50 000 characters
  countMax: 100000
});

const STATUS_LABELS_ = Object.freeze({
  pending: 'بانتظار المراجعة',
  approved: 'معتمد',
  returned: 'معاد للتصحيح'
});

const STAGES_ = Object.freeze(['ابتدائي', 'متوسط', 'ثانوي', 'رياض أطفال', 'مجمع', 'أخرى']);
const ATT_ROWS_ = Object.freeze(['students', 'teachers', 'staff']);
const ATT_LABELS_ = Object.freeze({ students: 'الطلاب', teachers: 'المعلمون', staff: 'الإداريون' });
const ATT_PART_LABELS_ = Object.freeze({ present: 'الحاضرون', absent: 'الغائبون' });
const FIELD_TYPES_ = Object.freeze(['number', 'text', 'textarea', 'select', 'yesno', 'attendance', 'photos']);
const KPIS_BY_TYPE_ = Object.freeze({
  number: ['late_students', 'lessons_planned', 'lessons_done'],
  select: ['mode']
});
const KPI_LABELS_ = Object.freeze({
  mode: 'نمط المتابعة',
  lessons_planned: 'الحصص المخطط لها',
  lessons_done: 'الحصص المفعّلة',
  late_students: 'الطلاب المتأخرون'
});
const PHOTO_MIMES_ = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });

const DAY_NAMES_ = Object.freeze(['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']);
const MONTH_NAMES_ = Object.freeze(['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس',
  'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']);

// Sheet layouts — column order is a contract (see spec §4.1).
const SCHOOL_COLS_ = Object.freeze(['id', 'name', 'ministryNo', 'stage', 'principal', 'phone', 'students',
  'teachers', 'staff', 'token', 'pin', 'active', 'createdAt']);
const SCHOOL_HEADERS_ = Object.freeze(['المعرّف', 'اسم المدرسة', 'الرقم الوزاري', 'المرحلة', 'المدير/ة', 'الجوال',
  'عدد الطلاب', 'عدد المعلمين', 'عدد الإداريين', 'رمز الرابط', 'رمز المدرسة', 'نشطة', 'تاريخ الإضافة']);
const SCHOOL_FORMATS_ = Object.freeze(['@', '@', '@', '@', '@', '@', '0', '0', '0', '@', '@', '@', '@']);
const SCHOOL_WIDTHS_ = Object.freeze([90, 240, 110, 100, 170, 125, 90, 95, 95, 190, 95, 70, 150]);

const REPORT_COLS_ = Object.freeze(['key', 'date', 'schoolId', 'schoolName', 'status', 'submittedAt', 'updatedAt',
  'filledBy', 'late', 'edits', 'reviewNote', 'reviewedAt', 'answersJson']);
const REPORT_HEADERS_ = Object.freeze(['المفتاح', 'التاريخ', 'معرّف المدرسة', 'المدرسة', 'الحالة', 'وقت الإرسال',
  'آخر تعديل', 'اسم المعبّئ', 'متأخر', 'مرات التعديل', 'ملاحظة المراجعة', 'وقت المراجعة', 'البيانات']);
const REPORT_FORMATS_ = Object.freeze(['@', '@', '@', '@', '@', '@', '@', '@', '@', '0', '@', '@', '@']);
const REPORT_WIDTHS_ = Object.freeze([150, 100, 95, 220, 130, 150, 150, 150, 65, 95, 230, 150, 140]);
const REPORT_FIXED_COLS_ = 13;

const LOG_HEADERS_ = Object.freeze(['الوقت', 'العملية', 'التفاصيل']);
const LOG_FORMATS_ = Object.freeze(['@', '@', '@']);
const LOG_WIDTHS_ = Object.freeze([160, 200, 520]);

const MSG_ = Object.freeze({
  BAD_LINK: 'الرابط غير صحيح أو تم تغييره. تواصل مع المشرف للحصول على الرابط الجديد.',
  INACTIVE: 'هذه المدرسة موقوفة مؤقتًا من قبل المشرف.',
  NOT_SETUP_SCHOOL: 'النظام لم يُجهّز بعد. تواصل مع المشرف.',
  NOT_EDITABLE: 'لا يمكن فتح تقرير هذا اليوم.',
  APPROVED_LOCKED: 'تم اعتماد هذا التقرير ولا يمكن تعديله',
  CLOSED: 'انتهى وقت الإرسال لهذا اليوم. تواصل مع المشرف.',
  PIN_WRONG: 'رمز المدرسة غير صحيح',
  PIN_LOCKED: 'محاولات كثيرة، حاول بعد ربع ساعة',
  GENERAL_OFF: 'الرابط العام غير مفعّل. استخدم رابط مدرستك الخاص.',
  OTP_COOLDOWN: 'انتظر دقيقة قبل طلب رمز جديد',
  OTP_HOURLY: 'طلبت رموزًا كثيرة خلال ساعة. حاول مرة أخرى بعد قليل.',
  OTP_MANY: 'طلبت رموزًا كثيرة خلال الساعات الماضية. حاول مرة أخرى بعد بضع ساعات.',
  OTP_TOO_MANY: 'تجاوزت عدد المحاولات، اطلب رمزًا جديدًا',
  OTP_EXPIRED: 'انتهت صلاحية الرمز، اطلب رمزًا جديدًا',
  SETUP_DONE: 'تم تجهيز النظام مسبقًا',
  PREVIEW: 'هذه صفحة معاينة فقط — لا يتم حفظ أو إرسال أي بيانات.',
  BUSY: 'النظام مشغول بطلبات أخرى الآن. حاول مرة أخرى بعد لحظات.',
  UNEXPECTED: 'حدث خطأ غير متوقع. حاول مرة أخرى بعد قليل.',
  BAD_DATE: 'التاريخ غير صحيح.',
  REPORT_NOT_FOUND: 'لم يُعثر على التقرير. ربما حُذف أو تغيّر.',
  SCHOOL_NOT_FOUND: 'لم يُعثر على المدرسة. ربما حُذفت.',
  PHOTO_NOT_FOUND: 'لم يُعثر على الصورة. ربما حُذفت.',
  UNAVAILABLE: 'النظام غير متاح مؤقتًا. تواصل مع المشرف.',
  PERM_MISSING: 'لم تُمنح كل أذونات البرنامج في حساب المشرف. على المشرف فتح ملف Google Sheets الخاص بالبرنامج ← ' +
    'القائمة «📋 نبض المدارس» ← «📖 خطوات التشغيل»، ثم اختيار «تحديد الكل» ← «متابعة» في نافذة الأذونات.',
  PERM_DRIVE: 'لم تُمنح صلاحية Google Drive اللازمة لحفظ صور الشواهد. على المشرف فتح ملف Google Sheets الخاص ' +
    'بالبرنامج ← القائمة «📋 نبض المدارس» ← «📖 خطوات التشغيل»، ثم اختيار «تحديد الكل» ← «متابعة» في نافذة الأذونات.',
  DRIVE_FULL: 'تعذّر حفظ الصورة لأن مساحة Google Drive لدى المشرف ممتلئة. أرسل التقرير بدون صور وأبلغ المشرف.'
});

const DEFAULT_MESSAGE_TEMPLATE = [
  'السلام عليكم ورحمة الله وبركاته',
  'سعادة مدير/ة {المدرسة} حفظكم الله',
  'نأمل تعبئة تقرير المتابعة اليومي عبر الرابط:',
  '{الرابط}',
  'شاكرين تعاونكم،',
  '{المشرف}'
].join('\n');

const DEFAULT_RETURN_TEMPLATE = [
  'السلام عليكم ورحمة الله',
  'سعادة مدير/ة {المدرسة}',
  'نأمل تصحيح تقرير يوم {التاريخ} حسب الملاحظة التالية:',
  '«{الملاحظة}»',
  'رابط التصحيح: {الرابط}',
  '{المشرف}'
].join('\n');

/** Defaults for the `cfg` Script Property. Never mutate: cfg_() deep-merges over a clone. */
const DEFAULT_CFG_ = Object.freeze({
  ssId: '',
  ownerEmail: '',
  setupDone: false,
  setupAt: '',
  systemTitle: DEFAULT_SYSTEM_TITLE,
  webAppUrl: '',               // the deployment URL ('…/exec') every link is built from (see baseUrl_)
  photosFolderId: '',
  photosFolderIdsOld: [],      // folders replaced after being trashed — their photos stay viewable
  sheetIds: {},                // data sheet name → sheet id (a renamed data sheet is found and renamed back)
  supervisor: { name: '', title: DEFAULT_SUPERVISOR_TITLE, office: '', phone: '' },
  schedule: { deadline: '09:00', workdays: [0, 1, 2, 3, 4], allowLate: true, backfillDays: 2 },
  review: { enabled: true },
  links: { generalEnabled: true },
  alerts: { studentAbsencePct: 10, teacherAbsencePct: 10, activationPct: 80, jumpPct: 50 },
  digest: { enabled: false, time: '10:00' },
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
  returnTemplate: DEFAULT_RETURN_TEMPLATE,
  version: APP_VERSION
});

/**
 * Ready-made forms. Preset fields carry STABLE ids so that switching presets
 * re-uses the same mirror columns in «التقارير» instead of duplicating them.
 */
const PRESET_FIELD_LIB_ = Object.freeze({
  mode: { id: 'f_mode01', label: 'نمط المتابعة', type: 'select', required: true, kpi: 'mode', help: '',
    options: ['حضوري', 'عن بُعد'] },
  attendance: { id: 'f_atten1', label: 'الحضور والغياب', type: 'attendance', required: true, kpi: null, help: '',
    rows: ['students', 'teachers', 'staff'] },
  planned: { id: 'f_lplan1', label: 'الحصص المخطط لها', type: 'number', required: true, kpi: 'lessons_planned',
    help: '', min: 0, max: null },
  done: { id: 'f_ldone1', label: 'الحصص المفعّلة', type: 'number', required: true, kpi: 'lessons_done',
    help: 'الحصص غير المفعّلة تُحسب تلقائيًا', min: 0, max: null },
  note: { id: 'f_note01', label: 'ملاحظة عامة', type: 'textarea', required: false, kpi: null, help: '' },
  notes: { id: 'f_note01', label: 'ملاحظات', type: 'textarea', required: false, kpi: null, help: '' },
  photos: { id: 'f_photo1', label: 'شواهد المتابعة', type: 'photos', required: false, kpi: null,
    help: 'صور فقط، حتى 6 صور. تُضغط الصور تلقائيًا قبل الرفع.', maxCount: 6 },
  lateStudents: { id: 'f_late01', label: 'عدد الطلاب المتأخرين', type: 'number', required: false,
    kpi: 'late_students', help: '', min: 0, max: null },
  earlyLeave: { id: 'f_perm01', label: 'عدد الطلاب المستأذنين (خروج مبكر)', type: 'number', required: false,
    kpi: null, help: '', min: 0, max: null },
  absentTeachers: { id: 'f_abst01', label: 'أسماء المعلمين الغائبين', type: 'textarea', required: false, kpi: null,
    help: 'اكتب كل اسم في سطر' },
  emergency: { id: 'f_emrg01', label: 'هل توجد حالة طارئة اليوم؟', type: 'yesno', required: true, kpi: null, help: '' }
});

const PRESETS_ = Object.freeze({
  standard: { label: 'متابعة سير العملية التعليمية',
    fields: ['mode', 'attendance', 'planned', 'done', 'note', 'photos'] },
  basic: { label: 'الحضور والغياب فقط',
    fields: ['attendance', 'notes'] },
  extended: { label: 'موسّع',
    fields: ['mode', 'attendance', 'planned', 'done', 'lateStudents', 'earlyLeave', 'absentTeachers', 'emergency',
      'note', 'photos'] }
});

/** Deployment steps (spec §9) — shown in «ابدأ هنا», the guide dialog and the README. */
const DEPLOY_STEPS_ = Object.freeze([
  'افتح رابط النسخ واضغط «إنشاء نسخة» — تصير عندك نسخة كاملة في حسابك.',
  'من القائمة العلوية في الملف: «الإضافات» ← «Apps Script».',
  'اضغط «نشر» ← «نشر جديد» ← أيقونة الترس ⚙ ← «تطبيق ويب».',
  '«التنفيذ باسم»: أنا — «من يمكنه الوصول»: أي شخص. ثم «نشر».',
  'اضغط «منح الإذن» ← اختر حسابك ← «خيارات متقدمة» ← «الانتقال إلى … (غير آمن)» ← ضع علامة على «تحديد الكل» ' +
    '(كل الأذونات) ← «متابعة». (هذه النسخة ملكك أنت، والتحذير يظهر لأن البرنامج لم يُنشر في متجر Google. ' +
    'إذن Google Drive يستخدمه البرنامج لمجلد صور الشواهد الذي يُنشئه فقط.)',
  'انسخ «رابط تطبيق الويب» (ينتهي بـ ⁦/exec⁩) وافتحه — سيظهر لك معالج التجهيز. احفظ الرابط في المفضلة.'
]);
const DEPLOY_UPDATE_NOTE_ = 'عند تحديث البرنامج لاحقًا: «نشر» ← «إدارة عمليات النشر» ← تعديل ← «إصدار جديد» — ' +
  'ليبقى الرابط نفسه دون تغيير. إذا طلب Google الموافقة على أذونات جديدة (أو توقفت الصور بعد التحديث) فافتح ' +
  'القائمة «📋 نبض المدارس» ← «📖 خطوات التشغيل» واختر «تحديد الكل» ← «متابعة».';

/** A deployed web-app URL: script.google.com/macros/s/<id>/exec (or the Workspace /a/macros/<domain>/ form). */
const WEBAPP_URL_RE_ = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/?#\s]+|macros)\/s\/[\w-]+\/exec$/;
const PRIVACY_NOTE_ = 'بياناتك محفوظة في هذا الملف وفي مجلد الشواهد داخل حسابك فقط';

// Per-execution memo (Apps Script starts every execution with fresh globals;
// bootstrap_() also resets it so long-lived test runtimes behave the same).
let MEMO_ = {};
let LOCK_DEPTH_ = 0;


// ═══════════════════════════════════════════════════════════════════════════
// 2. Pure helpers — strings, numbers, cells, ids, dates & times
// ═══════════════════════════════════════════════════════════════════════════

function isObj_(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function isNum_(v) { return typeof v === 'number' && isFinite(v); }
function pad2_(n) { n = Math.floor(Math.abs(n)); return n < 10 ? '0' + n : String(n); }
function clone_(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/** Object with the given values as keys (fast membership tests). */
function toSet_(arr) {
  const o = {};
  (arr || []).forEach((v) => { o[v] = true; });
  return o;
}

/** Arabic-Indic and Persian digits → Latin digits. */
function normDigits_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0));
}

/**
 * Cleans user text: strips control / invisible / bidi-override characters,
 * normalises new lines; single-line text collapses all whitespace.
 */
function cleanText_(v, multiline) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u2028\u2029\uFEFF\u202A-\u202E\u2066-\u2069]/g, '');
  if (multiline) {
    s = s.split('\n').map((l) => l.replace(/[ \t\u00A0]+$/g, '')).join('\n')
      .replace(/\n{4,}/g, '\n\n\n').trim();
  } else {
    s = s.replace(/[\s\u00A0]+/g, ' ').trim();
  }
  return s;
}

/** Comparison key: case-, space- and tatweel-insensitive. */
function normKey_(s) {
  return cleanText_(s).replace(/ـ/g, '').toLowerCase();
}

/** Sorting key for Arabic names (unifies hamza/alef forms, taa marbuta, alef maqsura). */
function sortKey_(s) {
  return normKey_(s).replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
}
function cmpName_(a, b) {
  const x = sortKey_(a), y = sortKey_(b);
  return x < y ? -1 : (x > y ? 1 : 0);
}

/** Any cell value → string. Dates (Sheets auto-conversion) → 'yyyy-MM-dd' / 'HH:mm' / timestamp. */
function cellStr_(v) {
  if (v === null || v === undefined) return '';
  if (isDate_(v)) {
    if (isNaN(v.getTime())) return '';
    const y = Number(Utilities.formatDate(v, TZ, 'yyyy'));
    if (y < 1900) return Utilities.formatDate(v, TZ, 'HH:mm');
    const s = Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
    return s.slice(11) === '00:00:00' ? s.slice(0, 10) : s;
  }
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v);
  // Plain-text cells keep safeCell_'s apostrophe literally — undo it on read.
  return /^'\s*[=+\-@']/.test(s) ? s.slice(1) : s;
}

/** Lenient boolean: true, 'TRUE', 'true', 'نعم', 1 → true. */
function toBool_(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === 'نعم' || s === '1' || s === 'yes';
  }
  return false;
}

/** Lenient integer for cells: numbers, numeric strings (incl. Arabic digits); otherwise `def`. */
function toInt_(v, def) {
  const d = def === undefined ? 0 : def;
  if (typeof v === 'number') return isFinite(v) ? Math.round(v) : d;
  if (typeof v === 'string') {
    const s = normDigits_(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
  }
  return d;
}

/**
 * Strict integer parsing for user input. Returns null for "empty", NaN for
 * anything that is not a whole number, otherwise the integer.
 */
function parseIntStrict_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = normDigits_(v).trim();
  if (s === '') return null;
  return /^-?\d{1,9}$/.test(s) ? parseInt(s, 10) : NaN;
}

/** Clamp a count read from a cell into 0..100000. */
function clampCount_(v) {
  const n = toInt_(v, 0);
  return n < 0 ? 0 : (n > LIMITS_.countMax ? LIMITS_.countMax : n);
}

/**
 * Formula-injection guard: strings starting with = + - @ (or an apostrophe,
 * which Sheets would swallow) are stored as literal text by prefixing "'".
 */
function safeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^\s*[=+\-@']/.test(v) ? "'" + v : v;
}

function escHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON safe to embed inside a <script> element. */
function safeJson_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** UTF-8 byte length (Script Properties limits are in bytes). */
function utf8Len_(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** Constant-time string comparison. */
function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 'supervisor.name@gmail.com' → 'su••••••@gmail.com' */
function maskEmail_(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '';
  return s.slice(0, Math.min(2, at)) + '••••••' + s.slice(at);
}

/** Deep merge for plain objects; arrays and primitives are replaced (cloned). */
function deepMerge_(base, over) {
  const out = isObj_(base) ? clone_(base) : {};
  if (!isObj_(over)) return out;
  Object.keys(over).forEach((k) => {
    const v = over[k];
    if (v === undefined) return;
    if (isObj_(v) && isObj_(out[k])) out[k] = deepMerge_(out[k], v);
    else out[k] = clone_(v);
  });
  return out;
}

// ---------- random identifiers (entropy from Utilities.getUuid via SHA-256) ----------

const ALNUM_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LOWER_ALNUM_ = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DIGITS_ = '0123456789';

function randomBytes_() {
  const seed = Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Math.random() + ':' + Date.now();
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
  const out = [];
  for (let i = 0; i < d.length; i++) out.push(d[i] & 0xFF);
  return out;
}

// Per-execution pool of random bytes (32 bytes per SHA-256 of two fresh UUIDs).
let RAND_POOL_ = [];

/** n characters from `alphabet`, unbiased (rejection sampling). */
function randStr_(n, alphabet) {
  const out = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < n) {
    if (!RAND_POOL_.length) RAND_POOL_ = randomBytes_();
    const b = RAND_POOL_.pop();
    if (b < limit) out.push(alphabet.charAt(b % alphabet.length));
  }
  return out.join('');
}

function sha256Hex_(s) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < d.length; i++) {
    const b = d[i] & 0xFF;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function newSchoolToken_() { return randStr_(1, LETTERS_) + randStr_(19, ALNUM_); }
function newSchoolId_() { return 'S' + randStr_(7, LOWER_ALNUM_); }
function newPin_() { return randStr_(4, DIGITS_); }
function newOtpCode_() { return randStr_(6, DIGITS_); }
function newSessionToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}
function newFieldId_(taken) {
  let id;
  do { id = 'f_' + randStr_(6, LOWER_ALNUM_); } while (taken && taken[id]);
  return id;
}

// ---------- dates ('yyyy-MM-dd', UTC math only) ----------

/** 'yyyy-MM-dd' → UTC ms at midnight, or null when not a real calendar date. */
function parseIso_(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return t;
}
function isIsoDate_(s) { return parseIso_(s) !== null; }
function isoFromUtc_(t) {
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}
function addDays_(iso, n) { return isoFromUtc_(parseIso_(iso) + n * 86400000); }
function diffDays_(a, b) { return Math.round((parseIso_(b) - parseIso_(a)) / 86400000); }
/** 0 = Sunday … 6 = Saturday. */
function weekday_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}
function isWorkday_(iso, workdays, holidaySet) {
  return (workdays || []).indexOf(weekday_(iso)) >= 0 && !(holidaySet && holidaySet[iso]);
}
/** 'الأربعاء 14 أكتوبر 2026' */
function dateLabelAr_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return String(iso || '');
  return DAY_NAMES_[weekday_(iso)] + ' ' + Number(m[3]) + ' ' + MONTH_NAMES_[Number(m[2]) - 1] + ' ' + m[1];
}
/** Day the school was added ('yyyy-MM-dd') or '' when unknown. */
function createdDate_(school) {
  const d = String((school && school.createdAt) || '').slice(0, 10);
  return isIsoDate_(d) ? d : '';
}
/**
 * First day a report is due from the school: the day it was added, or the next day when it was added
 * after that day's deadline (e.g. set up in the evening). '' = unknown (old rows → always due).
 */
function firstDueDate_(school, deadline) {
  const c = createdDate_(school);
  if (!c) return '';
  const hm = String(school.createdAt).slice(11, 16);
  return isHHMM_(hm) && isHHMM_(deadline) && hm > deadline ? addDays_(c, 1) : c;
}
function existedOn_(school, iso, deadline) {
  const c = firstDueDate_(school, deadline);
  return !c || c <= iso;
}
/**
 * The last `n` workdays strictly before `today` (newest first) — the days a school may still
 * report late when it sent nothing (schedule.backfillDays).
 */
function backfillDates_(today, workdays, holidaySet, n) {
  const out = [];
  if (!(n > 0) || !(workdays || []).length) return out;
  let d = today;
  for (let i = 0; i < 60 && out.length < n; i++) {
    d = addDays_(d, -1);
    if (isWorkday_(d, workdays, holidaySet)) out.push(d);
  }
  return out;
}

// ---------- times ----------

function isHHMM_(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
/** Accepts '9:05' or '09:05' → '09:05' (or '' when invalid). */
function normHHMM_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(normDigits_(cleanText_(s)));
  if (!m) return '';
  const out = pad2_(Number(m[1])) + ':' + m[2];
  return isHHMM_(out) ? out : '';
}
/** '09:40' → '9:40 ص' ; '14:05' → '2:05 م' ; also accepts a timestamp. */
function fmtTime12_(s) {
  const m = /(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(s || ''));
  if (!m) return '';
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + m[2] + ' ' + (h < 12 ? 'ص' : 'م');
}

function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowHM_() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function nowTs_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

// ---------- percentages ----------

function round1_(x) { return Math.round(x * 10) / 10; }
/** num/den×100 with 1 decimal; null when the denominator is 0. */
function pct_(num, den) { return den > 0 ? round1_(num / den * 100) : null; }
/** 14.2 → '14.2٪' ; 10 → '10٪' ; null → '—' */
function fmtPct_(x) {
  if (x === null || x === undefined || !isFinite(x)) return '—';
  return (Number.isInteger(x) ? String(x) : x.toFixed(1)) + '٪';
}

// ---------- phone numbers ----------

/**
 * Digits only (≤ 15): spaces, dashes and brackets are dropped and an international prefix
 * '+' or '00' becomes plain digits ('+966 55 111 2233' → '966551112233'), so a phone is never
 * stored with a formula-guard apostrophe and reads the same in RTL lines. Returns {ok, value}.
 */
function normalizePhone_(v) {
  let s = normDigits_(cleanText_(v)).replace(/[\s\-().\u200E\u200F_]/g, '');
  if (!s) return { ok: true, value: '' };
  if (/^\+\d/.test(s)) s = s.slice(1);
  else if (/^00\d/.test(s)) s = s.slice(2);
  if (!/^\d{3,15}$/.test(s)) return { ok: false, value: '' };
  return { ok: true, value: s };
}

// ---------- web-app URL ----------

/** A clean deployment URL ('…/exec', no query/hash) or '' (test /dev URLs and anything else are rejected). */
function cleanWebAppUrl_(u) {
  const s = String(u === null || u === undefined ? '' : u).trim().split('#')[0].split('?')[0];
  return WEBAPP_URL_RE_.test(s) ? s : '';
}

// ---------- report status ----------

function statusToApi_(label) {
  const s = cleanText_(label);
  if (s === STATUS_LABELS_.approved || s === 'approved') return 'approved';
  if (s === STATUS_LABELS_.returned || s === 'returned') return 'returned';
  return 'pending';
}
function statusToLabel_(status) { return STATUS_LABELS_[status] || STATUS_LABELS_.pending; }


// ═══════════════════════════════════════════════════════════════════════════
// 3. Domain logic (pure functions — plain data in, plain data out)
// ═══════════════════════════════════════════════════════════════════════════

// ---------- 3.1 Field presets & field validation ----------

function presetFields_(key) {
  const p = PRESETS_[key] || PRESETS_.standard;
  return p.fields.map((k) => clone_(PRESET_FIELD_LIB_[k]));
}

function presetList_() {
  return Object.keys(PRESETS_).map((k) => ({ key: k, label: PRESETS_[k].label }));
}

/**
 * Validates and normalises a full form definition (spec §5). Unknown keys are
 * dropped; ids of existing fields are preserved, new fields get 'f_' + 6 chars.
 * Throws a clear Arabic error naming the offending question.
 */
function validateFields_(input) {
  if (!Array.isArray(input)) fail_('بيانات النموذج غير صالحة.');
  if (!input.length) fail_('أضف سؤالًا واحدًا على الأقل إلى النموذج.');
  if (input.length > LIMITS_.fieldsMax) fail_('الحد الأقصى ' + LIMITS_.fieldsMax + ' سؤالًا في النموذج.');
  const out = [];
  const labels = {}, ids = {}, kpis = {};
  const single = { attendance: 0, photos: 0 };
  input.forEach((raw, i) => {
    const n = i + 1;
    if (!isObj_(raw)) fail_('السؤال رقم ' + n + ' غير صالح.');
    const rawLabel = cleanText_(raw.label);
    if (!rawLabel) fail_('اكتب نص السؤال رقم ' + n + '.');
    if (rawLabel.length > 80) fail_('نص السؤال رقم ' + n + ' أطول من 80 حرفًا.');
    const label = rawLabel;
    const q = '«' + label + '»';
    const lk = normKey_(label);
    if (labels[lk]) fail_('السؤال ' + q + ' مكرر. اجعل لكل سؤال نصًا مختلفًا.');
    labels[lk] = true;

    const type = typeof raw.type === 'string' ? raw.type : '';
    if (FIELD_TYPES_.indexOf(type) < 0) fail_('نوع السؤال ' + q + ' غير معروف.');
    if (type === 'attendance' || type === 'photos') {
      single[type]++;
      if (single[type] > 1) {
        fail_(type === 'attendance'
          ? 'يسمح النموذج بسؤال واحد فقط من نوع «حضور وغياب».'
          : 'يسمح النموذج بسؤال واحد فقط من نوع «صور».');
      }
    }

    const help = cleanText_(raw.help);
    if (help.length > 140) fail_('التوضيح في السؤال ' + q + ' أطول من 140 حرفًا.');

    let kpi = (raw.kpi === undefined || raw.kpi === null || raw.kpi === '') ? null : String(raw.kpi);
    if (kpi !== null) {
      if ((KPIS_BY_TYPE_[type] || []).indexOf(kpi) < 0) fail_('المؤشر المختار لا يناسب نوع السؤال ' + q + '.');
      if (kpis[kpi]) fail_('المؤشر «' + KPI_LABELS_[kpi] + '» مستخدم في أكثر من سؤال.');
      kpis[kpi] = true;
    }

    const id = (typeof raw.id === 'string' && /^f_[A-Za-z0-9]{3,12}$/.test(raw.id) && !ids[raw.id])
      ? raw.id : newFieldId_(ids);
    ids[id] = true;

    const f = { id: id, label: label, type: type, required: raw.required === true, kpi: kpi, help: help };

    if (type === 'number') {
      const min = (raw.min === undefined || raw.min === null || raw.min === '') ? 0 : parseIntStrict_(raw.min);
      if (!Number.isInteger(min) || min < 0 || min > LIMITS_.countMax) {
        fail_('أقل قيمة في السؤال ' + q + ' يجب أن تكون رقمًا من 0 إلى 100000.');
      }
      const max = (raw.max === undefined || raw.max === null || raw.max === '') ? null : parseIntStrict_(raw.max);
      if (max !== null && (!Number.isInteger(max) || max < min || max > LIMITS_.countMax)) {
        fail_('أكبر قيمة في السؤال ' + q + ' يجب أن تكون رقمًا من ' + min + ' إلى 100000.');
      }
      f.min = min;
      f.max = max;
    } else if (type === 'select') {
      let opts = Array.isArray(raw.options) ? raw.options
        : (typeof raw.options === 'string' ? raw.options.split('\n') : []);
      const seen = {};
      opts = opts.map((o) => cleanText_(o)).filter((o) => {
        if (!o) return false;
        const k = normKey_(o);
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
      if (opts.length < 2 || opts.length > 20) fail_('السؤال ' + q + ' يحتاج من 2 إلى 20 خيارًا.');
      if (opts.some((o) => o.length > 40)) fail_('كل خيار في السؤال ' + q + ' يجب ألا يتجاوز 40 حرفًا.');
      f.options = opts;
    } else if (type === 'attendance') {
      const wanted = Array.isArray(raw.rows) ? raw.rows : ATT_ROWS_.slice();
      const rows = ATT_ROWS_.filter((r) => wanted.indexOf(r) >= 0);
      if (!rows.length) fail_('اختر فئة واحدة على الأقل (الطلاب أو المعلمون أو الإداريون) في السؤال ' + q + '.');
      f.rows = rows;
    } else if (type === 'photos') {
      const mc = (raw.maxCount === undefined || raw.maxCount === null || raw.maxCount === '')
        ? 6 : parseIntStrict_(raw.maxCount);
      if (!Number.isInteger(mc) || mc < 1 || mc > 10) fail_('عدد الصور في السؤال ' + q + ' يجب أن يكون من 1 إلى 10.');
      f.maxCount = mc;
    }
    out.push(f);
  });
  return out;
}

function kpiField_(fields, kpi) {
  for (let i = 0; i < fields.length; i++) if (fields[i].kpi === kpi) return fields[i];
  return null;
}
function typeField_(fields, type) {
  for (let i = 0; i < fields.length; i++) if (fields[i].type === type) return fields[i];
  return null;
}

// ---------- 3.2 Answer validation ----------

function parseYesNo_(v) {
  if (v === true || v === 'true' || v === 'نعم' || v === 1) return true;
  if (v === false || v === 'false' || v === 'لا' || v === 0) return false;
  if (v === null || v === undefined || v === '') return null;
  return undefined;
}

/**
 * Validates a school's answers against the form (spec §5). Unknown ids are
 * ignored; empty optional answers are omitted. `verifyPhoto(id)` must return
 * {id, name, size} for a photo previously uploaded by THIS school, else null.
 */
function validateAnswers_(fields, answers, verifyPhoto) {
  const a = isObj_(answers) ? answers : {};
  const out = {};
  fields.forEach((f) => {
    const v = a[f.id];
    const q = '«' + f.label + '»';
    if (f.type === 'number') {
      const n = parseIntStrict_(v);
      if (n === null) { if (f.required) fail_('يرجى تعبئة ' + q + '.'); return; }
      if (Number.isNaN(n)) fail_(q + ': أدخل رقمًا صحيحًا.');
      const min = isNum_(f.min) ? f.min : 0;
      const max = isNum_(f.max) ? f.max : LIMITS_.countMax;
      if (n < min) fail_(q + ': أقل قيمة مسموحة ' + min + '.');
      if (n > max) fail_(q + ': أكبر قيمة مسموحة ' + max + '.');
      out[f.id] = n;
    } else if (f.type === 'text' || f.type === 'textarea') {
      const multi = f.type === 'textarea';
      const max = multi ? 1000 : 300;
      const s = cleanText_(v, multi);
      if (!s) { if (f.required) fail_('يرجى تعبئة ' + q + '.'); return; }
      if (s.length > max) fail_(q + ': النص أطول من المسموح (' + max + ' حرف).');
      out[f.id] = s;
    } else if (f.type === 'yesno') {
      const b = parseYesNo_(v);
      if (b === undefined) fail_(q + ': اختر «نعم» أو «لا».');
      if (b === null) { if (f.required) fail_('يرجى الإجابة عن ' + q + '.'); return; }
      out[f.id] = b;
    } else if (f.type === 'select') {
      const s = cleanText_(v);
      if (!s) { if (f.required) fail_('يرجى اختيار ' + q + '.'); return; }
      if ((f.options || []).indexOf(s) < 0) fail_(q + ': اختر من الخيارات المتاحة.');
      out[f.id] = s;
    } else if (f.type === 'attendance') {
      const val = isObj_(v) ? v : {};
      if (v !== null && v !== undefined && v !== '' && !isObj_(v)) fail_(q + ': بيانات الحضور غير صالحة.');
      const res = {};
      (f.rows || ATT_ROWS_).forEach((r) => {
        const rl = ATT_LABELS_[r];
        const cell = isObj_(val[r]) ? val[r] : {};
        const p = parseIntStrict_(cell.present);
        const ab = parseIntStrict_(cell.absent);
        if (Number.isNaN(p) || Number.isNaN(ab)) fail_(q + ': أدخل أرقامًا صحيحة لفئة ' + rl + '.');
        if ((p !== null && (p < 0 || p > LIMITS_.countMax)) || (ab !== null && (ab < 0 || ab > LIMITS_.countMax))) {
          fail_(q + ': الأرقام في فئة ' + rl + ' يجب أن تكون من 0 إلى 100000.');
        }
        if (p === null && ab === null) {
          if (f.required) fail_(q + ': أدخل عدد الحاضرين والغائبين لفئة ' + rl + '.');
          return;
        }
        if (p === null || ab === null) fail_(q + ': أكمل عدد الحاضرين والغائبين لفئة ' + rl + '.');
        if (f.required && p + ab === 0) fail_(q + ': مجموع الحاضرين والغائبين لفئة ' + rl + ' لا يمكن أن يكون صفرًا.');
        res[r] = { present: p, absent: ab };
      });
      if (Object.keys(res).length) out[f.id] = res;
    } else if (f.type === 'photos') {
      if (v !== null && v !== undefined && v !== '' && !Array.isArray(v)) fail_(q + ': بيانات الصور غير صالحة.');
      const list = Array.isArray(v) ? v : [];
      const maxCount = isNum_(f.maxCount) ? f.maxCount : 6;
      if (list.length > maxCount) fail_(q + ': الحد الأقصى ' + maxCount + ' صور.');
      const seen = {};
      const photos = [];
      list.forEach((item) => {
        const id = isObj_(item) && typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || seen[id]) return;
        seen[id] = true;
        const ok = verifyPhoto ? verifyPhoto(id) : null;
        if (!ok) fail_(q + ': إحدى الصور غير متاحة أو حُذفت. احذفها ثم ارفعها من جديد.');
        photos.push({
          id: ok.id || id,
          name: cleanText_(item.name).slice(0, 100) || String(ok.name || ''),
          w: Math.max(0, Math.min(20000, toInt_(item.w, 0))),
          h: Math.max(0, Math.min(20000, toInt_(item.h, 0))),
          size: isNum_(ok.size) ? ok.size : Math.max(0, toInt_(item.size, 0))
        });
      });
      if (!photos.length) { if (f.required) fail_('يرجى إرفاق صورة واحدة على الأقل في ' + q + '.'); return; }
      out[f.id] = photos;
    }
  });
  const fp = kpiField_(fields, 'lessons_planned');
  const fd = kpiField_(fields, 'lessons_done');
  if (fp && fd && isNum_(out[fp.id]) && isNum_(out[fd.id]) && out[fd.id] > out[fp.id]) {
    fail_('عدد الحصص المفعّلة لا يمكن أن يتجاوز عدد الحصص المخطط لها');
  }
  return out;
}

/** All photo ids referenced by an answers object. */
function photoIds_(answers) {
  const ids = [];
  if (!isObj_(answers)) return ids;
  Object.keys(answers).forEach((k) => {
    const v = answers[k];
    if (Array.isArray(v)) v.forEach((p) => { if (isObj_(p) && typeof p.id === 'string' && p.id) ids.push(p.id); });
  });
  return ids;
}

// ---------- 3.3 Derived metrics ----------

function isAttendanceShape_(v) {
  return isObj_(v) && ATT_ROWS_.some((r) => isObj_(v[r]) && ('present' in v[r] || 'absent' in v[r]));
}

/**
 * A KPI answer: from the current KPI question, or — for reports saved before that question was
 * deleted / re-created — from a retired question id that carried the same KPI. Retired ids still
 * used by any current question are ignored (its answers now mean something else).
 */
function kpiVal_(a, fl, kpi, retired) {
  const f = kpiField_(fl, kpi);
  const ok = (v) => (kpi === 'mode' ? typeof v === 'string' && v !== '' : isNum_(v));
  if (f && ok(a[f.id])) return a[f.id];
  const ids = isObj_(retired) && Array.isArray(retired[kpi]) ? retired[kpi] : [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || fl.some((x) => x.id === id)) continue;
    if (ok(a[id])) return a[id];
  }
  return null;
}

/**
 * Derived metrics of one report (spec §5/§6 `derived`). `retired` ({kpi: [old field ids]}, optional)
 * keeps the KPIs of reports answered with questions that were deleted or re-created since.
 */
function deriveReport_(fields, answers, retired) {
  const a = isObj_(answers) ? answers : {};
  const fl = Array.isArray(fields) ? fields : [];
  const d = { attendance: {}, lessons: null, mode: null, lateStudents: null, photosCount: 0 };

  // At most one attendance question exists, so an answer of attendance shape under another id
  // belongs to a deleted / re-created attendance question — use it when the current one is empty.
  const attF = typeField_(fl, 'attendance');
  let att = attF ? a[attF.id] : null;
  if (!isAttendanceShape_(att)) {
    const k = Object.keys(a).filter((key) => isAttendanceShape_(a[key]))[0];
    att = k ? a[k] : null;
  }
  if (isObj_(att)) {
    ATT_ROWS_.forEach((r) => {
      const c = att[r];
      if (!isObj_(c) || !isNum_(c.present) || !isNum_(c.absent)) return;
      const total = c.present + c.absent;
      d.attendance[r] = { present: c.present, absent: c.absent, total: total, absencePct: pct_(c.absent, total) };
    });
  }

  const fp = kpiField_(fl, 'lessons_planned');
  const fd = kpiField_(fl, 'lessons_done');
  const planned = kpiVal_(a, fl, 'lessons_planned', retired);
  const done = kpiVal_(a, fl, 'lessons_done', retired);
  if (fp || fd || planned !== null || done !== null) {
    const both = planned !== null && done !== null;
    d.lessons = {
      planned: planned,
      done: done,
      notActivated: both ? Math.max(planned - done, 0) : null,
      activationPct: both ? pct_(done, planned) : null
    };
  }

  d.mode = kpiVal_(a, fl, 'mode', retired);
  d.lateStudents = kpiVal_(a, fl, 'late_students', retired);

  d.photosCount = photoIds_(a).length;
  return d;
}

/** Public Report object (spec §6) from an internal record. */
function reportOut_(rec, fields, retired) {
  return {
    date: rec.date,
    status: rec.status,
    answers: rec.answers || {},
    filledBy: rec.filledBy || '',
    submittedAt: rec.submittedAt || '',
    updatedAt: rec.updatedAt || '',
    late: !!rec.late,
    edits: rec.edits || 0,
    reviewNote: rec.reviewNote || '',
    reviewedAt: rec.reviewedAt || '',
    derived: deriveReport_(fields, rec.answers, retired)
  };
}

// ---------- 3.4 Edit rules ----------

/**
 * May the school edit / submit TODAY's report?
 *  - no report: yes, unless the deadline passed and late submissions are off
 *  - returned: always
 *  - approved by the supervisor: never
 *  - auto-approved (review disabled, never reviewed): like pending
 *  - pending: when late is allowed or the deadline has not passed
 */
function canEditToday_(existing, ctx) {
  const openNow = ctx.allowLate || !ctx.pastDeadline;
  if (!existing) return openNow;
  if (existing.status === 'returned') return true;
  if (existing.status === 'approved') return !ctx.reviewEnabled && !existing.reviewedAt && openNow;
  return openNow;
}

/** 'open' | 'late' | 'closed' for today's form. */
function formState_(pastDeadline, allowLate, hasExisting) {
  if (!pastDeadline) return 'open';
  if (allowLate || hasExisting) return 'late';
  return 'closed';
}

// ---------- 3.5 Bulk school text (spec §6.5) ----------

const BULK_HEADER_WORDS_ = Object.freeze(['اسم المدرسة', 'المدرسة', 'المدارس', 'اسم المدرسه', 'name', 'school']);
const BULK_LEAD_CELL_RE_ = /^(?:[\d٠-٩]{1,15}|م|#)$/;

/**
 * Parses pasted school lines: `name [, principal [, phone [, students [, teachers [, staff]]]]]`
 * separated by tab, comma, Arabic comma or '|'. Returns {items, skipped, count}.
 */
function parseBulkSchools_(text, existingNames) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const seen = {};
  (existingNames || []).forEach((n) => { seen[normKey_(n)] = true; });
  const items = [], skipped = [];
  let count = 0;
  lines.forEach((line, i) => {
    if (!cleanText_(line)) return;
    count++;
    const lineNo = i + 1;
    const parts = line.split(/[\t,،|]/).map((p) => cleanText_(p));
    // Excel lists often start with a serial «م» or a ministry-number column: drop a purely
    // numeric first cell (or the «م» / «#» header cell) when more cells follow.
    if (parts.length > 1 && BULK_LEAD_CELL_RE_.test(parts[0])) parts.shift();
    let name = parts[0]
      .replace(/^[\d٠-٩]{1,3}\s*[-.)–]\s*/, '')
      .replace(/^[•●▪\-*]\s*/, '')
      .trim();
    if (BULK_HEADER_WORDS_.indexOf(normKey_(name)) >= 0) { skipped.push({ line: lineNo, reason: 'سطر عناوين' }); return; }
    if (name.length < 2 || name.length > 120) { skipped.push({ line: lineNo, reason: 'اسم غير صالح' }); return; }
    const k = normKey_(name);
    if (seen[k]) { skipped.push({ line: lineNo, reason: 'مكررة' }); return; }
    seen[k] = true;
    const phone = normalizePhone_(parts[2] || '');
    const count_ = (v) => {
      const n = parseIntStrict_(v || '');
      return Number.isInteger(n) && n >= 0 && n <= LIMITS_.countMax ? n : 0;
    };
    items.push({
      line: lineNo,
      name: name,
      principal: (parts[1] || '').slice(0, 60),
      phone: phone.ok ? phone.value : '',
      students: count_(parts[3]),
      teachers: count_(parts[4]),
      staff: count_(parts[5])
    });
  });
  return { items: items, skipped: skipped, count: count };
}

// ---------- 3.6 Day dashboard (spec §6.3 api_day) ----------

function newAttAgg_() { return { present: 0, absent: 0, total: 0, absencePct: null, n: 0 }; }
function finishAttAgg_(a) {
  return { present: a.present, absent: a.absent, total: a.total, absencePct: a.n ? pct_(a.absent, a.total) : null };
}
function schoolRef_(s, base) {
  return {
    id: s.id, name: s.name, principal: s.principal || '', phone: s.phone || '',
    students: s.students || 0, teachers: s.teachers || 0, staff: s.staff || 0, stage: s.stage || '',
    active: s.active !== false,
    link: base && s.token ? schoolLink_(base, s.token) : null
  };
}
function workdaysPhrase_(n) {
  if (n === 2) return 'يومَي عمل متتاليين';
  if (n >= 3 && n <= 10) return n + ' أيام عمل متتالية';
  return n + ' يوم عمل متتاليًا';
}

/**
 * Builds the day dashboard from plain data.
 * o = { date, today, now, deadline, workdays, holidays, thresholds, reviewEnabled, allowLate, backfillDays,
 *       schools:[school], reports:{schoolId: Report}, snapshots:{schoolId: name},
 *       history:{schoolId:[pct,…newest first]}, datesBySchool:{schoolId:{date:true}},
 *       pendingOther:[…], returnedOther:[…], modeOptions:[…], baseUrl }
 */
function buildDay_(o) {
  const hs = toSet_(o.holidays || []);
  const th = o.thresholds;
  const isHoliday = !!hs[o.date];
  const isWorkday = isWorkday_(o.date, o.workdays, hs);
  const isToday = o.date === o.today;
  const elapsed = o.date <= o.today;
  const deadlinePassed = o.date < o.today || (isToday && o.now > o.deadline);
  const reports = o.reports || {};
  // Can a school WITHOUT a report still send one for this date? (today: unless closed after the
  // deadline; a past workday: only inside the late-reporting window, schedule.backfillDays)
  const canSubmit = isToday
    ? (!isWorkday || o.allowLate !== false || !(o.now > o.deadline))
    : (o.date < o.today && isWorkday &&
      backfillDates_(o.today, o.workdays, hs, o.backfillDays || 0).indexOf(o.date) >= 0);

  // Rows: active schools due that day + any school that has a report that day.
  const rows = [];
  const included = {};
  (o.schools || []).forEach((s) => {
    const rep = reports[s.id] || null;
    if (!rep && (!s.active || !existedOn_(s, o.date, o.deadline))) return;
    included[s.id] = true;
    rows.push({ school: schoolRef_(s, o.baseUrl), report: rep, flags: [], _created: firstDueDate_(s, o.deadline) });
  });
  Object.keys(reports).forEach((id) => {
    if (included[id]) return;
    const name = (o.snapshots && o.snapshots[id]) || 'مدرسة محذوفة';
    rows.push({ school: schoolRef_({ id: id, name: name, active: false }), report: reports[id], flags: [], _created: '' });
  });

  const rank = (r) => (!r.report ? 0 : r.report.status === 'returned' ? 1 : r.report.status === 'pending' ? 2 : 3);
  rows.sort((a, b) => (rank(a) - rank(b)) || cmpName_(a.school.name, b.school.name));

  const totals = {
    schools: rows.length, submitted: 0, missing: 0, pending: 0, approved: 0, returned: 0, late: 0,
    students: null, teachers: null, staff: null, lessons: null, lateStudents: null, modes: {}
  };
  (o.modeOptions || []).forEach((m) => { totals.modes[m] = 0; });
  const agg = { students: newAttAgg_(), teachers: newAttAgg_(), staff: newAttAgg_() };
  const les = { planned: 0, done: 0, n: 0 };
  let lateStudents = null;
  const alerts = [];
  const alert = (level, type, row, text) => alerts.push({ level: level, type: type, schoolId: row.school.id, text: text });

  rows.forEach((row) => {
    const rep = row.report;
    const nm = row.school.name;
    const flags = row.flags;
    if (rep) {
      totals.submitted++;
      totals[rep.status]++;
      if (rep.late) totals.late++;
      const d = rep.derived || {};
      const att = d.attendance || {};
      ATT_ROWS_.forEach((r) => {
        const c = att[r];
        if (!c) return;
        agg[r].present += c.present; agg[r].absent += c.absent; agg[r].total += c.total; agg[r].n++;
      });
      if (d.lessons && isNum_(d.lessons.planned) && isNum_(d.lessons.done)) {
        les.planned += d.lessons.planned; les.done += d.lessons.done; les.n++;
      }
      if (isNum_(d.lateStudents)) lateStudents = (lateStudents || 0) + d.lateStudents;
      if (d.mode) totals.modes[d.mode] = (totals.modes[d.mode] || 0) + 1;

      const st = att.students, te = att.teachers;
      if (st && st.absencePct !== null && st.absencePct >= th.studentAbsencePct) {
        flags.push('high_absence');
        alert('danger', 'high_absence', row, 'غياب الطلاب في «' + nm + '» بلغ ' + fmtPct_(st.absencePct) +
          ' — أعلى من الحد (' + fmtPct_(th.studentAbsencePct) + ')');
      }
      if (te && te.absencePct !== null && te.absencePct >= th.teacherAbsencePct) {
        flags.push('teacher_absence');
        alert('warn', 'teacher_absence', row, 'غياب المعلمين في «' + nm + '» بلغ ' + fmtPct_(te.absencePct) +
          ' — أعلى من الحد (' + fmtPct_(th.teacherAbsencePct) + ')');
      }
      if (d.lessons && d.lessons.activationPct !== null && d.lessons.activationPct < th.activationPct) {
        flags.push('low_activation');
        alert('warn', 'low_activation', row, 'تفعيل الحصص في «' + nm + '» بلغ ' + fmtPct_(d.lessons.activationPct) +
          ' — أقل من المستهدف (' + fmtPct_(th.activationPct) + ')');
      }
      const prev = ((o.history || {})[row.school.id] || []).slice(0, 10);
      if (st && st.absencePct !== null && prev.length >= 3) {
        const avg = prev.reduce((s, x) => s + x, 0) / prev.length;
        if (st.absencePct >= avg * (1 + th.jumpPct / 100) && st.absencePct - avg >= 3) {
          flags.push('jump');
          alert('warn', 'jump', row, 'ارتفاع مفاجئ في غياب الطلاب في «' + nm + '»: ' + fmtPct_(st.absencePct) +
            ' مقابل متوسط ' + fmtPct_(round1_(avg)) + ' في الأيام السابقة');
        }
      }
      if (rep.late) {
        flags.push('late');
        alert('info', 'late', row, '«' + nm + '» أرسلت التقرير بعد الموعد' +
          (rep.submittedAt ? ' (' + fmtTime12_(rep.submittedAt) + ')' : ''));
      }
      if (rep.status === 'returned') flags.push('returned');
      if (rep.status === 'pending' && rep.reviewNote) {
        flags.push('corrected');
        alert('info', 'corrected', row, '«' + nm + '» صحّحت التقرير المُعاد — بانتظار مراجعتك');
      }
    } else if (isWorkday && elapsed && row.school.active) {
      flags.push('missing');
      totals.missing++;
      if (deadlinePassed) {
        const dates = (o.datesBySchool || {})[row.school.id] || {};
        let streak = 0;
        let d = o.date;
        for (let i = 0; i < 90 && streak < 60; i++) {
          if (row._created && d < row._created) break;
          if (isWorkday_(d, o.workdays, hs)) {
            if (dates[d]) break;
            streak++;
          }
          d = addDays_(d, -1);
        }
        if (streak >= 2) {
          flags.push('missing_streak');
          alert('danger', 'missing_streak', row, '«' + nm + '» لم ترسل التقرير منذ ' + workdaysPhrase_(streak));
        }
      }
    }
  });

  totals.students = finishAttAgg_(agg.students);
  totals.teachers = finishAttAgg_(agg.teachers);
  totals.staff = finishAttAgg_(agg.staff);
  totals.lessons = {
    planned: les.planned,
    done: les.done,
    notActivated: Math.max(les.planned - les.done, 0),
    activationPct: les.n ? pct_(les.done, les.planned) : null
  };
  totals.lateStudents = lateStudents;

  const lvl = { danger: 0, warn: 1, info: 2 };
  alerts.forEach((a, i) => { a._i = i; });
  alerts.sort((a, b) => (lvl[a.level] - lvl[b.level]) || (a._i - b._i));
  alerts.forEach((a) => { delete a._i; });
  rows.forEach((r) => { delete r._created; });

  return {
    date: o.date,
    today: o.today,
    isWorkday: isWorkday,
    isHoliday: isHoliday,
    isToday: isToday,
    now: o.now,
    deadline: o.deadline,
    allowLate: o.allowLate !== false,
    canSubmit: canSubmit,
    reviewEnabled: !!o.reviewEnabled,
    totals: totals,
    rows: rows,
    alerts: alerts,
    pendingOther: o.pendingOther || [],
    returnedOther: o.returnedOther || []
  };
}

// ---------- 3.7 Range statistics (spec §6.3 api_range) ----------

function newSums_() { return { sa: 0, st: 0, ta: 0, tt: 0, lp: 0, ld: 0, nl: 0 }; }
function addSums_(s, d) {
  const att = (d && d.attendance) || {};
  if (att.students) { s.sa += att.students.absent; s.st += att.students.total; }
  if (att.teachers) { s.ta += att.teachers.absent; s.tt += att.teachers.total; }
  if (d && d.lessons && isNum_(d.lessons.planned) && isNum_(d.lessons.done)) {
    s.lp += d.lessons.planned; s.ld += d.lessons.done; s.nl++;
  }
}

/**
 * Statistics for a date range from plain data. Ratios come from sums
 * (Σ absent / Σ total), never from averages of averages.
 * o = { from, to, today, now, deadline, workdays, holidays, schools, modeOptions,
 *       recs:[{date, schoolId, schoolName, status, late, derived}] }
 * Today counts as expected only for schools that already reported until the deadline passes
 * (`now`/`deadline` absent → today is fully expected), so mornings do not drag compliance down.
 * `onTime` / `onTimeDays` count reports on expected days only (always ≤ `expected` / `expectedDays`);
 * `submitted` / `submittedDays` count every report (off days, inactive or deleted schools included).
 */
function buildRange_(o) {
  const hs = toSet_(o.holidays || []);
  const dates = [];
  for (let d = o.from; d <= o.to; d = addDays_(d, 1)) dates.push(d);
  const byDate = {};
  o.recs.forEach((r) => { (byDate[r.date] = byDate[r.date] || []).push(r); });

  const modeInit = () => {
    const m = {};
    (o.modeOptions || []).forEach((k) => { m[k] = 0; });
    return m;
  };
  const per = {};
  const order = [];
  const addSchool = (id, name) => {
    if (per[id]) return per[id];
    per[id] = { id: id, name: name, submittedDays: 0, expectedDays: 0, onTime: 0, sums: newSums_(),
      lateCount: 0, returnedCount: 0, modes: modeInit() };
    order.push(id);
    return per[id];
  };
  const schoolsById = {};
  (o.schools || []).forEach((s) => { schoolsById[s.id] = s; if (s.active) addSchool(s.id, s.name); });
  o.recs.forEach((r) => {
    const s = schoolsById[r.schoolId];
    addSchool(r.schoolId, s ? s.name : (r.schoolName || 'مدرسة محذوفة'));
  });

  const tot = newSums_();
  const totModes = modeInit();
  let workdays = 0, totExpected = 0, totSubmittedExpected = 0;

  const days = dates.map((date) => {
    const wd = isWorkday_(date, o.workdays, hs);
    const elapsed = date <= o.today;
    if (wd && elapsed) workdays++;
    const expectedIds = {};
    let expected = 0;
    const recs = byDate[date] || [];
    if (wd && elapsed) {
      const notDueYet = date === o.today && isHHMM_(o.deadline) && isHHMM_(o.now) && o.now <= o.deadline;
      const sent = toSet_(recs.map((r) => r.schoolId));
      (o.schools || []).forEach((s) => {
        if (s.active && existedOn_(s, date, o.deadline) && (!notDueYet || sent[s.id])) {
          expectedIds[s.id] = true; expected++; per[s.id].expectedDays++;
        }
      });
    }
    const sums = newSums_();
    let late = 0, subExp = 0;
    recs.forEach((r) => {
      const p = per[r.schoolId];
      addSums_(sums, r.derived); addSums_(tot, r.derived); addSums_(p.sums, r.derived);
      p.submittedDays++;
      if (expectedIds[r.schoolId]) { subExp++; p.onTime++; }
      if (r.late) { late++; p.lateCount++; }
      if (r.status === 'returned') p.returnedCount++;
      const m = r.derived && r.derived.mode;
      if (m) { p.modes[m] = (p.modes[m] || 0) + 1; totModes[m] = (totModes[m] || 0) + 1; }
    });
    totExpected += expected;
    totSubmittedExpected += subExp;
    return {
      date: date,
      isWorkday: wd,
      submitted: recs.length,
      onTime: subExp,
      expected: expected,
      compliancePct: pct_(subExp, expected),
      studentAbsencePct: pct_(sums.sa, sums.st),
      teacherAbsencePct: pct_(sums.ta, sums.tt),
      activationPct: sums.nl ? pct_(sums.ld, sums.lp) : null,
      late: late
    };
  });

  const schools = order.map((id) => {
    const p = per[id];
    return {
      id: p.id,
      name: p.name,
      submittedDays: p.submittedDays,
      onTimeDays: p.onTime,
      extraDays: p.submittedDays - p.onTime,
      expectedDays: p.expectedDays,
      compliancePct: pct_(p.onTime, p.expectedDays),
      avgStudentAbsencePct: pct_(p.sums.sa, p.sums.st),
      avgTeacherAbsencePct: pct_(p.sums.ta, p.sums.tt),
      avgActivationPct: p.sums.nl ? pct_(p.sums.ld, p.sums.lp) : null,
      lateCount: p.lateCount,
      returnedCount: p.returnedCount,
      modes: p.modes
    };
  }).sort((a, b) => cmpName_(a.name, b.name));

  return {
    from: o.from,
    to: o.to,
    workdays: workdays,
    days: days,
    schools: schools,
    totals: {
      compliancePct: pct_(totSubmittedExpected, totExpected),
      avgStudentAbsencePct: pct_(tot.sa, tot.st),
      avgTeacherAbsencePct: pct_(tot.ta, tot.tt),
      avgActivationPct: tot.nl ? pct_(tot.ld, tot.lp) : null,
      reports: o.recs.length,
      modes: totModes
    }
  };
}

// ---------- 3.8 Dynamic mirror columns of «التقارير» ----------

/** Column specs for the current fields: [{key, header, num, fieldId, type, row?, part?}] */
function fieldColumns_(fields) {
  const out = [];
  (fields || []).forEach((f) => {
    if (f.type === 'attendance') {
      (f.rows || ATT_ROWS_).forEach((r) => {
        ['present', 'absent'].forEach((part) => {
          out.push({ key: f.id + '.' + r + '.' + part, header: ATT_LABELS_[r] + ' - ' + ATT_PART_LABELS_[part],
            num: true, fieldId: f.id, type: 'att', row: r, part: part });
        });
      });
    } else {
      out.push({ key: f.id, header: f.label, num: f.type === 'number', fieldId: f.id, type: f.type });
    }
  });
  return out;
}

function driveFileUrl_(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }
function driveFolderUrl_(id) { return id ? 'https://drive.google.com/drive/folders/' + id : null; }

/** Value written to a mirror column (numbers as numbers, yes/no as نعم/لا, photos as URLs). */
function mirrorValue_(spec, answers) {
  const v = isObj_(answers) ? answers[spec.fieldId] : undefined;
  if (spec.type === 'att') {
    const c = isObj_(v) && isObj_(v[spec.row]) ? v[spec.row][spec.part] : null;
    return isNum_(c) ? c : '';
  }
  if (spec.type === 'number') return isNum_(v) ? v : '';
  if (spec.type === 'yesno') return v === true ? 'نعم' : (v === false ? 'لا' : '');
  if (spec.type === 'photos') {
    return Array.isArray(v) ? v.filter((p) => isObj_(p) && p.id).map((p) => driveFileUrl_(p.id)).join('\n') : '';
  }
  return typeof v === 'string' ? v : '';
}


// ═══════════════════════════════════════════════════════════════════════════
// 4. Platform glue — errors, lock, properties, cache, config
// ═══════════════════════════════════════════════════════════════════════════

/** Throws an error whose message is shown to the user as-is. */
function fail_(msg) {
  const e = new Error(msg);
  e.nabdUser = true;
  throw e;
}

/** Like fail_, for a hand-edited sheet layout the app refuses to touch (supervisor-facing text). */
function layoutFail_(msg) {
  const e = new Error(msg);
  e.nabdUser = true;
  e.nabdLayout = true;
  throw e;
}

/** A platform error caused by a permission (scope) the owner did not grant. */
function isPermErr_(e) {
  return /not sufficient|do not have permission|Required permissions|Authorization is required|authorization required/i
    .test(String((e && e.message) || e || ''));
}

/** True when the owner skipped some permissions on Google's (granular) consent screen. Never throws. */
function scopesMissing_() {
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    return info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED;
  } catch (e) {
    return false;
  }
}

/** Clear Arabic text for a permission problem (null when `e` is not one). */
function permMessage_(e) {
  if (!isPermErr_(e) && !scopesMissing_()) return null;
  return /DriveApp|auth\/drive/.test(String((e && e.message) || e || '')) ? MSG_.PERM_DRIVE : MSG_.PERM_MISSING;
}

/**
 * Runs an exposed function: bootstrap first, then the body. Expected errors
 * (fail_) reach the client unchanged; anything else is logged and replaced by
 * a calm Arabic message, so users never see raw stack traces.
 * opts.school = true for principal-facing calls: a sheet-layout problem (meant for the
 * supervisor) becomes the neutral «النظام غير متاح مؤقتًا».
 */
function run_(fn, opts) {
  try {
    bootstrap_(opts);
    return fn();
  } catch (e) {
    if (e && e.nabdLayout && opts && opts.school) fail_(MSG_.UNAVAILABLE);
    if (e && e.nabdUser) throw e;
    try { console.error((e && e.stack) || String(e)); } catch (ignore) { /* no console */ }
    const perm = permMessage_(e);
    if (perm) fail_(perm);
    throw new Error(MSG_.UNEXPECTED);
  }
}

/** Drops cached sheet/config data (after acquiring the lock, data may have changed). */
function invalidate_() {
  const keep = { ss: MEMO_.ss, sheetsOk: MEMO_.sheetsOk, baseUrl: MEMO_.baseUrl, layoutOk: MEMO_.layoutOk };
  MEMO_ = keep;
}

/** Script lock around every write path (re-entrant within one execution). */
function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    fail_(MSG_.BUSY);
  }
  LOCK_DEPTH_++;
  try {
    invalidate_();
    return fn();
  } finally {
    LOCK_DEPTH_--;
    try { SpreadsheetApp.flush(); } catch (ignore) { /* nothing to flush */ }
    lock.releaseLock();
  }
}

function props_() { return PropertiesService.getScriptProperties(); }
function cache_() { return CacheService.getScriptCache(); }

/** Reads a property that may be stored in chunks (values > 8 KB). */
function getBigProp_(key) {
  const p = props_();
  const raw = p.getProperty(key);
  if (raw === null || raw === undefined) return null;
  const m = /^@@chunks:(\d+)$/.exec(raw);
  if (!m) return raw;
  let s = '';
  for (let i = 1; i <= Number(m[1]); i++) s += p.getProperty(key + '#' + i) || '';
  return s;
}

/** Writes a property, splitting it into ≤ 8 KB chunks when needed. */
function setBigProp_(key, str) {
  const p = props_();
  const prev = p.getProperty(key);
  const pm = prev ? /^@@chunks:(\d+)$/.exec(prev) : null;
  const prevChunks = pm ? Number(pm[1]) : 0;
  let chunks = 0;
  if (utf8Len_(str) <= LIMITS_.propChunkBytes) {
    p.setProperty(key, str);
  } else {
    const parts = [];
    let cur = '', bytes = 0;
    for (let i = 0; i < str.length; i++) {
      let ch = str.charAt(i);
      const c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) { ch += str.charAt(i + 1); i++; }
      const b = utf8Len_(ch);
      if (bytes + b > LIMITS_.propChunkBytes) { parts.push(cur); cur = ''; bytes = 0; }
      cur += ch; bytes += b;
    }
    if (cur) parts.push(cur);
    parts.forEach((part, i) => p.setProperty(key + '#' + (i + 1), part));
    chunks = parts.length;
    p.setProperty(key, '@@chunks:' + chunks);
  }
  for (let i = chunks + 1; i <= prevChunks; i++) p.deleteProperty(key + '#' + i);
}

function readJsonProp_(key, def) {
  try {
    const raw = getBigProp_(key);
    if (!raw) return def;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? def : v;
  } catch (e) {
    return def;
  }
}

function cacheInt_(key) {
  const n = parseInt(cache_().get(key), 10);
  return isFinite(n) ? n : 0;
}
function cacheIncr_(key, ttlSec) {
  const n = cacheInt_(key) + 1;
  cache_().put(key, String(n), ttlSec);
  return n;
}

/** Count inside a fixed time window (the window does not slide with each hit). */
function windowCount_(key) {
  let w = null;
  try { w = JSON.parse(cache_().get(key) || 'null'); } catch (e) { w = null; }
  return isObj_(w) && Number(w.until) > Date.now() ? (Number(w.n) || 0) : 0;
}
function windowIncr_(key, windowSec) {
  const now = Date.now();
  let w = null;
  try { w = JSON.parse(cache_().get(key) || 'null'); } catch (e) { w = null; }
  if (!isObj_(w) || !(Number(w.until) > now)) w = { n: 0, until: now + windowSec * 1000 };
  w.n = (Number(w.n) || 0) + 1;
  cache_().put(key, JSON.stringify(w), Math.max(1, Math.ceil((w.until - now) / 1000)));
  return w.n;
}

// ---------- config ----------

function cfg_() {
  if (MEMO_.cfg) return MEMO_.cfg;
  const stored = readJsonProp_('cfg', {});
  MEMO_.cfg = deepMerge_(DEFAULT_CFG_, isObj_(stored) ? stored : {});
  return MEMO_.cfg;
}

/** Deep-merges `partial` into the stored config. */
function saveCfg_(partial) {
  return withLock_(() => {
    const stored = readJsonProp_('cfg', {});
    const next = deepMerge_(deepMerge_(DEFAULT_CFG_, isObj_(stored) ? stored : {}), partial);
    setBigProp_('cfg', JSON.stringify(next));
    MEMO_.cfg = next;
    return next;
  });
}

function fields_() {
  if (MEMO_.fields) return MEMO_.fields;
  const f = readJsonProp_('fields', null);
  MEMO_.fields = Array.isArray(f) && f.length ? f : presetFields_('standard');
  return MEMO_.fields;
}

function saveFields_(fields) {
  return withLock_(() => {
    retireKpis_(fields_(), fields);
    setBigProp_('fields', JSON.stringify(fields));
    MEMO_.fields = fields;
    syncFieldCols_(sheet_(SH_REPORTS), fields);
    return fields;
  });
}

/** {kpi: [field ids]} of KPI questions that were deleted / replaced — keeps past reports' KPIs readable. */
function retiredKpis_() {
  if (MEMO_.retiredKpis) return MEMO_.retiredKpis;
  const r = readJsonProp_('retiredKpis', {});
  MEMO_.retiredKpis = isObj_(r) ? r : {};
  return MEMO_.retiredKpis;
}

/** Remembers the ids of KPI questions that the new form no longer uses for that KPI (inside the lock). */
function retireKpis_(oldFields, newFields) {
  const cur = {};
  (newFields || []).forEach((f) => { if (f.kpi) cur[f.kpi] = f.id; });
  const r = clone_(retiredKpis_());
  let changed = false;
  (oldFields || []).forEach((f) => {
    if (!f || !f.kpi || cur[f.kpi] === f.id || typeof f.id !== 'string') return;
    const list = Array.isArray(r[f.kpi]) ? r[f.kpi].filter((x) => x !== f.id) : [];
    list.unshift(f.id);
    r[f.kpi] = list.slice(0, 6);
    changed = true;
  });
  if (!changed) return;
  setBigProp_('retiredKpis', JSON.stringify(r));
  MEMO_.retiredKpis = r;
}

function holidays_() {
  if (MEMO_.holidays) return MEMO_.holidays;
  const h = readJsonProp_('holidays', []);
  MEMO_.holidays = Array.isArray(h) ? h.filter(isIsoDate_) : [];
  return MEMO_.holidays;
}

function fieldColsMap_() {
  if (MEMO_.fieldCols) return MEMO_.fieldCols;
  const m = readJsonProp_('fieldCols', {});
  MEMO_.fieldCols = isObj_(m) ? m : {};
  return MEMO_.fieldCols;
}

/** What ScriptApp reports as this script's URL ('' when unknown). Never throws. */
function serviceUrl_() {
  try { return String(ScriptApp.getService().getUrl() || ''); } catch (e) { return ''; }
}
/** The page was opened from the test deployment (…/dev) — its links do not work for schools. */
function devMode_() { return /\/dev(?:[?#].*)?$/.test(serviceUrl_()); }

/**
 * The deployment URL every school / general link is built from, or null when unknown.
 * The URL saved in the settings (cfg.webAppUrl) always wins: ScriptApp.getService().getUrl() is
 * the HEAD '/dev' URL in the test deployment (a different id from the real '/exec' one, so it is
 * never rewritten) and is unreliable outside a web-app request. A live '/exec' URL is only a fallback.
 */
function baseUrl_() {
  if (MEMO_.baseUrl !== undefined) return MEMO_.baseUrl;
  MEMO_.baseUrl = cleanWebAppUrl_(cfg_().webAppUrl) || cleanWebAppUrl_(serviceUrl_()) || null;
  return MEMO_.baseUrl;
}
/** Only the saved URL — for menu dialogs and triggers, where getUrl() cannot know the deployment. */
function baseUrlStored_() {
  return cleanWebAppUrl_(cfg_().webAppUrl) || null;
}
function linkWith_(base, query) {
  return base ? base + (base.indexOf('?') >= 0 ? '&' : '?') + query : null;
}
function schoolLink_(base, token) { return linkWith_(base, 's=' + encodeURIComponent(token)); }
function generalLink_(base) { return linkWith_(base, 'f=all'); }


// ═══════════════════════════════════════════════════════════════════════════
// 5. Storage — sheets, «ابدأ هنا», schools, reports, dynamic columns, log
// ═══════════════════════════════════════════════════════════════════════════

const DATA_SS_NAME_ = 'نبض المدارس — البيانات';

/**
 * The data spreadsheet, memoised per execution: the bound (active) spreadsheet; else
 * openById(cfg.ssId); else — a standalone install with nothing stored yet — a new spreadsheet
 * «نبض المدارس — البيانات» in the owner's Drive, whose id is saved (bootstrap_ then adds the sheets).
 */
function ss_() {
  if (MEMO_.ss) return MEMO_.ss;
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    const stored = readJsonProp_('cfg', {});
    if (stored && stored.ssId) ss = SpreadsheetApp.openById(stored.ssId);
  }
  if (!ss) {
    ss = withLock_(() => {
      const again = readJsonProp_('cfg', {});
      if (again && again.ssId) return SpreadsheetApp.openById(again.ssId);
      const created = SpreadsheetApp.create(DATA_SS_NAME_);
      try { created.setSpreadsheetTimeZone(TZ); } catch (e) { /* optional */ }
      saveCfg_({ ssId: created.getId() });
      return created;
    });
  }
  if (!ss) throw new Error('Spreadsheet not available');
  MEMO_.ss = ss;
  return ss;
}

const SHEET_DEFS_ = Object.freeze([
  { name: SH_SCHOOLS, headers: SCHOOL_HEADERS_, formats: SCHOOL_FORMATS_, widths: SCHOOL_WIDTHS_, tab: '#0A6453' },
  { name: SH_REPORTS, headers: REPORT_HEADERS_, formats: REPORT_FORMATS_, widths: REPORT_WIDTHS_, tab: '#0E7C66' },
  { name: SH_LOG, headers: LOG_HEADERS_, formats: LOG_FORMATS_, widths: LOG_WIDTHS_, tab: '#6B7C86' }
]);

function sheetDef_(name) {
  for (let i = 0; i < SHEET_DEFS_.length; i++) if (SHEET_DEFS_[i].name === name) return SHEET_DEFS_[i];
  return null;
}

/**
 * A data sheet by name; when it was renamed by hand («المدارس 1447») it is found by its saved
 * sheet id and renamed back, instead of a new empty sheet being created (links would all break).
 */
function findDataSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (sh) return sh;
  const id = (cfg_().sheetIds || {})[name];
  if (id === undefined || id === null || id === '') return null;
  const all = ss.getSheets();
  for (let i = 0; i < all.length; i++) {
    let sid = null;
    try { sid = all[i].getSheetId(); } catch (e) { sid = null; }
    if (String(sid) === String(id) && SHEET_DEFS_.every((d) => d.name !== all[i].getName())) {
      try { all[i].setName(name); } catch (e) { return null; }
      return all[i];
    }
  }
  return null;
}

/** Creates/repairs the data sheets (idempotent; cheap when everything exists). */
function ensureSheets_() {
  if (MEMO_.sheetsOk) return;
  const ss = ss_();
  const broken = () => SHEET_DEFS_.some((d) => {
    const sh = ss.getSheetByName(d.name);
    return !sh || sh.getLastRow() === 0;
  });
  let repaired = false;
  if (broken()) {
    repaired = true;
    withLock_(() => {
      let reportsCreated = false;
      const restored = [];
      SHEET_DEFS_.forEach((d) => {
        let sh = ss.getSheetByName(d.name);
        if (!sh) {
          sh = findDataSheet_(ss, d.name);   // renamed by hand → renamed back
          if (sh) restored.push(d.name);
        }
        if (!sh) sh = ss.insertSheet(d.name);
        if (sh.getLastRow() === 0) {
          setupDataSheet_(sh, d);
          if (d.name === SH_REPORTS) reportsCreated = true;
        }
      });
      MEMO_.sheetsOk = true;
      if (reportsCreated) {
        setBigProp_('fieldCols', '{}');
        MEMO_.fieldCols = null;
        syncFieldCols_(ss.getSheetByName(SH_REPORTS), fields_());
      }
      restored.forEach((name) => log_('استعادة اسم ورقة', 'أُعيد اسم الورقة «' + name + '» لأن النظام يعتمد عليه.'));
    });
  }
  MEMO_.sheetsOk = true;
  rememberSheetIds_(ss, repaired);
}

/** Saves the data sheets' ids (first run, or after a repair) so a renamed sheet can be found again. */
function rememberSheetIds_(ss, force) {
  try {
    const stored = cfg_().sheetIds || {};
    if (!force && SHEET_DEFS_.every((d) => stored[d.name] !== undefined && stored[d.name] !== '')) return;
    const ids = {};
    let changed = false;
    SHEET_DEFS_.forEach((d) => {
      const sh = ss.getSheetByName(d.name);
      if (!sh) return;
      ids[d.name] = sh.getSheetId();
      if (String(stored[d.name]) !== String(ids[d.name])) changed = true;
    });
    if (changed) saveCfg_({ sheetIds: ids });
  } catch (e) { /* optional */ }
}

function setupDataSheet_(sh, d) {
  const n = d.headers.length;
  sh.getRange(1, 1, 1, n).setValues([d.headers.slice()]);
  styleHeader_(sh, n);
  try { sh.setFrozenRows(1); } catch (e) { /* ignore */ }
  try { sh.setRightToLeft(true); } catch (e) { /* ignore */ }
  try { sh.setTabColor(d.tab); } catch (e) { /* ignore */ }
  try { sh.setRowHeight(1, 34); } catch (e) { /* ignore */ }
  d.widths.forEach((w, i) => { try { sh.setColumnWidth(i + 1, w); } catch (e) { /* ignore */ } });
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  applyFormats_(sh, 2, rows, 1, d.formats);
  if (d.name === SH_REPORTS) {
    try {
      sh.getRange(1, 1).setNote('معرّف داخلي يستخدمه النظام — لا تعدّله.');
      sh.getRange(1, REPORT_FIXED_COLS_).setNote('نسخة كاملة من إجابات التقرير يستخدمها النظام — لا تعدّلها. ' +
        'الأعمدة التي بعدها تعرض الإجابات بشكل مقروء.');
    } catch (e) { /* ignore */ }
  }
  if (d.name === SH_SCHOOLS) {
    try {
      sh.getRange(1, 1).setNote('معرّف داخلي يستخدمه النظام — لا تعدّله. لا تُدرج أعمدة أو صفوفًا قبل العمود الأخير — ' +
        'أضف أعمدتك بعد «تاريخ الإضافة».');
      sh.getRange(1, 10).setNote('رمز الرابط الخاص بالمدرسة. لتغييره استخدم «تغيير الرابط» من لوحة التحكم.');
      sh.getRange(1, 11).setNote('رمز من 4 أرقام تستخدمه المدرسة مع الرابط العام فقط.');
    } catch (e) { /* ignore */ }
  }
}

function styleHeader_(sh, n) {
  sh.getRange(1, 1, 1, n)
    .setFontWeight('bold')
    .setBackground(BRAND_COLOR)
    .setFontColor('#FFFFFF')
    .setVerticalAlignment('middle');
}

/** Applies number formats (array, one per column starting at `col`) — one call per run of equal formats. */
function applyFormats_(sh, startRow, numRows, col, formats) {
  if (numRows < 1) return;
  let i = 0;
  while (i < formats.length) {
    let j = i;
    while (j + 1 < formats.length && formats[j + 1] === formats[i]) j++;
    sh.getRange(startRow, col + i, numRows, j - i + 1).setNumberFormat(formats[i]);
    i = j + 1;
  }
}

/** Formats for newly inserted rows (fixed columns + known mirror columns). */
function formatNewRows_(sh, startRow, numRows) {
  const d = sheetDef_(sh.getName());
  if (!d) return;
  applyFormats_(sh, startRow, numRows, 1, d.formats);
  if (d.name !== SH_REPORTS) return;
  const map = fieldColsMap_();
  const nums = {};
  fieldColumns_(fields_()).forEach((c) => { nums[c.key] = c.num; });
  Object.keys(map).forEach((key) => {
    const col = map[key];
    if (!(col > REPORT_FIXED_COLS_)) return;
    const num = key in nums ? nums[key] : /\.(present|absent)$/.test(key);
    sh.getRange(startRow, col, numRows, 1).setNumberFormat(num ? '0' : '@');
  });
}

/** Makes sure row `lastNeeded` exists (grows the sheet in blocks, keeping formats). */
function ensureRows_(sh, lastNeeded) {
  const max = sh.getMaxRows();
  if (lastNeeded <= max) return;
  const add = Math.max(lastNeeded - max, 200);
  sh.insertRowsAfter(max, add);
  formatNewRows_(sh, max + 1, add);
}

/**
 * Deletes one data row. Sheets refuses to delete the last non-frozen row ("it is not possible to
 * delete all non-frozen rows"), which happens when a sheet was trimmed to header + 1 row by hand,
 * so a spare (formatted) row is added first in that case.
 */
function deleteDataRow_(sh, row) {
  const max = sh.getMaxRows();
  if (max - 1 <= sh.getFrozenRows()) {
    sh.insertRowsAfter(max, 1);
    formatNewRows_(sh, max + 1, 1);
  }
  sh.deleteRow(row);
}

/** Makes sure column `lastNeeded` exists. */
function ensureCols_(sh, lastNeeded) {
  const max = sh.getMaxColumns();
  if (lastNeeded <= max) return;
  if (typeof sh.insertColumnsAfter === 'function') sh.insertColumnsAfter(max, lastNeeded - max);
}

/** Writes a 2-D block, applying safeCell_ to every string. */
function writeBlock_(sh, row, col, values) {
  if (!values.length) return;
  const safe = values.map((r) => r.map((v) => (v === null || v === undefined) ? '' : safeCell_(v)));
  sh.getRange(row, col, safe.length, safe[0].length).setValues(safe);
}

function sheet_(name) {
  ensureSheets_();
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet ' + name);
  if (name === SH_SCHOOLS || name === SH_REPORTS) checkLayout_(sh, sheetDef_(name));
  return sh;
}

/** First header that is not where the app expects it: {col, want, got} or null. Pure. */
function layoutMismatch_(headers, row) {
  for (let i = 0; i < headers.length; i++) {
    const got = cleanText_(cellStr_(row[i]));
    if (got !== headers[i]) return { col: i + 1, want: headers[i], got: got };
  }
  return null;
}

function layoutMessage_(sheetName, bad) {
  return 'تم تعديل أعمدة الورقة «' + sheetName + '» (أُضيف عمود أو حُذف أو نُقل، أو أُضيف صف فوق العناوين): ' +
    'العمود ' + String.fromCharCode(64 + bad.col) + ' يجب أن يكون «' + bad.want + '»' +
    (bad.got ? ' وفيه الآن «' + bad.got.slice(0, 40) + '»' : ' وهو الآن فارغ') + '. ' +
    'أعِد الورقة كما كانت (تراجع بـ Ctrl+Z، أو احذف العمود أو الصف المضاف، أو استرجع نسخة سابقة من ' +
    '«ملف ← سجل الإصدارات») ثم حدّث الصفحة. يمكنك إضافة أعمدتك بعد آخر عمود فقط. لم يُعدَّل أي شيء.';
}

/**
 * «المدارس» and «التقارير» are read by column position, so their row-1 headers must be exactly
 * the app's. A hand-inserted / deleted column (or a title row above the headers) stops every read
 * and write with a clear message instead of silently reading the wrong columns (and, for schools,
 * "repairing" every link and pin). Checked once per execution and sheet.
 */
function checkLayout_(sh, d, fresh) {
  const ok = MEMO_.layoutOk || (MEMO_.layoutOk = {});
  if (ok[d.name] && !fresh) return;
  const n = Math.min(d.headers.length, Math.max(sh.getMaxColumns(), 1));
  const row = sh.getRange(1, 1, 1, n).getValues()[0];
  const bad = layoutMismatch_(d.headers, row);
  if (bad) layoutFail_(layoutMessage_(d.name, bad));
  ok[d.name] = true;
}

// ---------- «ابدأ هنا» start sheet ----------

/** Creates the friendly instruction sheet as the first tab (no-op when it exists). */
function ensureStartSheet_() {
  const ss = ss_();
  if (ss.getSheetByName(SH_START)) return false;
  return withLock_(() => {
    if (ss.getSheetByName(SH_START)) return false;
    buildStartSheet_(ss);
    return true;
  });
}

function buildStartSheet_(ss) {
  const sh = ss.insertSheet(SH_START, 0);
  try { sh.setRightToLeft(true); } catch (e) { /* ignore */ }
  try { sh.setHiddenGridlines(true); } catch (e) { /* ignore */ }
  try { sh.setTabColor('#B8892B'); } catch (e) { /* ignore */ }

  // Layout: A = margin, B = step number, C:H = text (merged).
  const W = 7; // columns B..H
  const rows = [];
  const line = (b, c) => { const r = new Array(W).fill(''); r[0] = b || ''; if (c !== undefined) r[1] = c; rows.push(r); };
  line('نبض المدارس');                                                   // 2
  line('متابعة سير العملية التعليمية — نسخة مستقلة خاصة بك');              // 3
  line('');                                                              // 4
  line('نظام بسيط يُرسل فيه كل مدير مدرسة تقرير المتابعة اليومي من جواله (نمط المتابعة، الحضور والغياب، ' +
    'تفعيل الحصص، الشواهد) عبر رابط خاص بمدرسته، وتتابع أنت كل التقارير لحظة بلحظة من لوحة تحكم واحدة: ' +
    'مراجعة واعتماد، تنبيهات ذكية، تقارير قابلة للطباعة، وإحصاءات عبر الأيام.');  // 5
  line('');                                                              // 6
  line('خطوات التشغيل (مرة واحدة فقط — حوالي 5 دقائق)');                   // 7
  DEPLOY_STEPS_.forEach((s, i) => line(String(i + 1), s));               // 8..13
  line('', DEPLOY_UPDATE_NOTE_);                                         // 14
  line('');                                                              // 15
  line('🔒  ' + PRIVACY_NOTE_ + '.');                                    // 16
  line('بعد التجهيز: من القائمة العلوية «📋 نبض المدارس» ← «🔗 رابط لوحة التحكم» تصل إلى لوحتك في أي وقت.'); // 17
  line('تستطيع قراءة البيانات وفرزها وتصفيتها في الأوراق بحرية، لكن لا تغيّر أسماء الأوراق ولا ترتيب أعمدتها.'); // 18

  const first = 2, n = rows.length;
  sh.getRange(first, 2, n, W).setNumberFormat('@').setValues(rows)
    .setFontFamily('Tahoma').setFontSize(12).setFontColor('#10222B').setVerticalAlignment('middle').setWrap(true);
  sh.setColumnWidth(1, 28);
  sh.setColumnWidth(2, 52);
  for (let c = 3; c <= 8; c++) sh.setColumnWidth(c, 118);

  const merge = (r, fromCol) => sh.getRange(r, fromCol, 1, 8 - fromCol + 1).merge();
  [2, 3, 5, 7, 16, 17, 18].forEach((r) => merge(r, 2));
  for (let r = 8; r <= 14; r++) merge(r, 3);

  sh.getRange(2, 2).setFontSize(26).setFontWeight('bold').setFontColor(BRAND_COLOR);
  sh.getRange(3, 2).setFontSize(14).setFontColor('#3E5360');
  sh.setRowHeight(2, 54);
  sh.setRowHeight(3, 28);
  sh.getRange(5, 2).setFontSize(13).setFontColor('#3E5360');
  sh.setRowHeight(5, 86);
  sh.getRange(7, 2, 1, W).setBackground('#E6F3EF');
  sh.getRange(7, 2).setFontSize(15).setFontWeight('bold').setFontColor('#084F42');
  sh.setRowHeight(7, 38);
  sh.getRange(8, 2, DEPLOY_STEPS_.length, 1).setBackground(BRAND_COLOR).setFontColor('#FFFFFF')
    .setFontWeight('bold').setFontSize(14).setHorizontalAlignment('center');
  sh.getRange(8, 3, DEPLOY_STEPS_.length, 1).setFontSize(13);
  for (let r = 8; r < 8 + DEPLOY_STEPS_.length; r++) sh.setRowHeight(r, r === 12 ? 88 : 44);
  sh.getRange(14, 3).setFontSize(11).setFontColor('#6B7C86');
  sh.setRowHeight(14, 54);
  sh.getRange(16, 2, 1, W).setBackground('#FBF3E2');
  sh.getRange(16, 2).setFontSize(13).setFontWeight('bold').setFontColor('#7A5A12');
  sh.setRowHeight(16, 40);
  sh.getRange(17, 2).setFontSize(12).setFontColor('#3E5360');
  sh.getRange(18, 2).setFontSize(11).setFontColor('#6B7C86');
  sh.setRowHeight(17, 34);
  sh.setRowHeight(18, 34);

  // Remove the empty default sheet a brand-new spreadsheet comes with.
  try {
    ss.getSheets().forEach((s) => {
      const nm = s.getName();
      if (/^(Sheet|ورقة|الورقة)\s?1$/.test(nm) && s.getLastRow() === 0 && s.getLastColumn() === 0 &&
          ss.getSheets().length > 1) {
        ss.deleteSheet(s);
      }
    });
  } catch (e) { /* ignore */ }
}

// ---------- schools ----------

function schoolRow_(s) {
  return [s.id, s.name, s.ministryNo || '', s.stage || '', s.principal || '', s.phone || '',
    s.students || 0, s.teachers || 0, s.staff || 0, s.token, s.pin, s.active ? 'نعم' : 'لا', s.createdAt || ''];
}

const INACTIVE_RE_ = /^(?:لا|false|0|no|غير نشطة|موقوفة)$/i;

/** One sheet row → school object (null for blank rows). Pure. */
function parseSchoolRow_(v, row) {
  const name = cleanText_(cellStr_(v[1]));
  if (!name) return null;
  let pin = normDigits_(cellStr_(v[10])).trim();
  if (/^\d{1,4}$/.test(pin)) pin = ('0000' + pin).slice(-4);
  const activeRaw = cellStr_(v[11]).trim();
  const phoneRaw = cleanText_(cellStr_(v[5]));
  const phone = normalizePhone_(phoneRaw);
  return {
    _row: row,
    id: cellStr_(v[0]).trim(),
    name: name,
    ministryNo: cleanText_(cellStr_(v[2])),
    stage: cleanText_(cellStr_(v[3])),
    principal: cleanText_(cellStr_(v[4])),
    phone: phone.ok ? phone.value : phoneRaw,
    students: clampCount_(v[6]),
    teachers: clampCount_(v[7]),
    staff: clampCount_(v[8]),
    token: cellStr_(v[9]).trim(),
    pin: pin,
    active: activeRaw === '' || !INACTIVE_RE_.test(activeRaw),   // only an explicit «لا» stops a school
    createdAt: cellStr_(v[12]).trim(),
    _activeBlank: activeRaw === ''
  };
}

/** Rows typed by hand (or copy-pasted duplicates) need an id/token/pin. Pure. */
function schoolNeedsRepair_(s, seenIds, seenTokens) {
  return !/^[A-Za-z0-9_-]{1,20}$/.test(s.id) || !!seenIds[s.id] ||
    !/^[A-Za-z0-9]{12,64}$/.test(s.token) || !!seenTokens[s.token] ||
    !/^\d{4}$/.test(s.pin) || s._activeBlank;
}

function readSchools_() {
  if (MEMO_.schools) return MEMO_.schools;
  const sh = sheet_(SH_SCHOOLS);
  const last = sh.getLastRow();
  let list = [];
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, SCHOOL_COLS_.length).getValues();
    const ids = {}, toks = {};
    let repair = false;
    vals.forEach((v, i) => {
      const s = parseSchoolRow_(v, i + 2);
      if (!s) return;
      if (schoolNeedsRepair_(s, ids, toks)) repair = true;
      ids[s.id] = true; toks[s.token] = true;
      list.push(s);
    });
    if (repair) list = withLock_(() => repairSchools_(sh));
  }
  MEMO_.schools = list;
  return list;
}

/**
 * Gives hand-typed / duplicated rows a fresh id, token and pin (inside the lock). The header row is
 * re-checked first: a shifted layout must never be "repaired" (it would replace every link and pin).
 */
function repairSchools_(sh) {
  checkLayout_(sh, sheetDef_(SH_SCHOOLS), true);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, SCHOOL_COLS_.length).getValues();
  const ids = {}, toks = {}, list = [], fixed = [];
  vals.forEach((v, i) => {
    const s = parseSchoolRow_(v, i + 2);
    if (!s) return;
    if (schoolNeedsRepair_(s, ids, toks)) {
      let fresh = false;
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(s.id) || ids[s.id]) {
        do { s.id = newSchoolId_(); } while (ids[s.id]);
        fresh = true;
      }
      if (!/^[A-Za-z0-9]{12,64}$/.test(s.token) || toks[s.token]) {
        do { s.token = newSchoolToken_(); } while (toks[s.token]);
        fresh = true;
      }
      if (!/^\d{4}$/.test(s.pin)) s.pin = newPin_();
      if (fresh && !s.createdAt) s.createdAt = nowTs_();
      s._activeBlank = false;
      writeBlock_(sh, s._row, 1, [schoolRow_(s)]);
      fixed.push(s.name);
    }
    ids[s.id] = true; toks[s.token] = true;
    list.push(s);
  });
  if (fixed.length) {
    log_('إكمال بيانات صفوف المدارس', fixed.length + ' صف (معرّف/رابط/رمز ناقص أو مكرر): ' + fixed.slice(0, 20).join('، '));
  }
  return list;
}

function schoolById_(id) {
  if (typeof id !== 'string' || !id) return null;
  const list = readSchools_();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Exact-match lookup by private token. */
function schoolByToken_(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9]{12,64}$/.test(token)) return null;
  const list = readSchools_();
  for (let i = 0; i < list.length; i++) if (list[i].token && safeEq_(list[i].token, token)) return list[i];
  return null;
}

/** A new school record with unique id/token/pin. */
function newSchool_(existing, data) {
  const ids = toSet_(existing.map((s) => s.id));
  const toks = toSet_(existing.map((s) => s.token));
  let id, token;
  do { id = newSchoolId_(); } while (ids[id]);
  do { token = newSchoolToken_(); } while (toks[token]);
  return Object.assign({ id: id, name: '', ministryNo: '', stage: '', principal: '', phone: '',
    students: 0, teachers: 0, staff: 0 }, data, { token: token, pin: newPin_(), active: true, createdAt: nowTs_() });
}

function appendSchools_(list) {
  if (!list.length) return;
  const sh = sheet_(SH_SCHOOLS);
  const start = Math.max(sh.getLastRow(), 1) + 1;
  ensureRows_(sh, start + list.length - 1);
  writeBlock_(sh, start, 1, list.map(schoolRow_));
  MEMO_.schools = null;
}

function updateSchoolRow_(s) {
  writeBlock_(sheet_(SH_SCHOOLS), s._row, 1, [schoolRow_(s)]);
  MEMO_.schools = null;
}

/** School object for the supervisor (includes token, pin and the private link). */
function adminSchool_(s, base) {
  return {
    id: s.id, name: s.name, ministryNo: s.ministryNo || '', stage: s.stage || '', principal: s.principal || '',
    phone: s.phone || '', students: s.students || 0, teachers: s.teachers || 0, staff: s.staff || 0,
    token: s.token, pin: s.pin, active: !!s.active, createdAt: s.createdAt || '',
    link: base ? schoolLink_(base, s.token) : null
  };
}

// ---------- reports ----------

function reportFixedRow_(rec) {
  return [rec.date + '|' + rec.schoolId, rec.date, rec.schoolId, rec.schoolName || '', statusToLabel_(rec.status),
    rec.submittedAt || '', rec.updatedAt || '', rec.filledBy || '', rec.late ? 'نعم' : 'لا', rec.edits || 0,
    rec.reviewNote || '', rec.reviewedAt || '', JSON.stringify(rec.answers || {})];
}

function normDateCell_(v) {
  const s = cellStr_(v).trim().slice(0, 10);
  return isIsoDate_(s) ? s : '';
}

/** One sheet row (13 fixed columns) → internal record. Pure. */
function parseReportRow_(v, row) {
  const date = normDateCell_(v[1]);
  const schoolId = cellStr_(v[2]).trim();
  if (!date || !schoolId) return null;
  let answers = {};
  try {
    const a = JSON.parse(cellStr_(v[12]) || '{}');
    if (isObj_(a)) answers = a;
  } catch (e) { answers = {}; }
  return {
    row: row,
    key: date + '|' + schoolId,
    date: date,
    schoolId: schoolId,
    schoolName: cellStr_(v[3]),
    status: statusToApi_(cellStr_(v[4])),
    submittedAt: cellStr_(v[5]).trim(),
    updatedAt: cellStr_(v[6]).trim(),
    filledBy: cellStr_(v[7]),
    late: toBool_(v[8]),
    edits: Math.max(0, toInt_(v[9], 0)),
    reviewNote: cellStr_(v[10]),
    reviewedAt: cellStr_(v[11]).trim(),
    answers: answers
  };
}

/**
 * Light index of every report: columns A..E only (key, date, school, name, status).
 * Returns { list:[{row,key,date,schoolId,schoolName,status}], byKey }.
 */
function reportIndex_() {
  if (MEMO_.rIndex) return MEMO_.rIndex;
  const sh = sheet_(SH_REPORTS);
  const last = sh.getLastRow();
  const list = [], byKey = {};
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, 5).getValues();
    for (let i = 0; i < vals.length; i++) {
      const date = normDateCell_(vals[i][1]);
      const schoolId = cellStr_(vals[i][2]).trim();
      if (!date || !schoolId) continue;
      const key = date + '|' + schoolId;
      if (byKey[key]) continue;
      const e = { row: i + 2, key: key, date: date, schoolId: schoolId, schoolName: cellStr_(vals[i][3]),
        status: statusToApi_(cellStr_(vals[i][4])) };
      list.push(e);
      byKey[key] = e;
    }
  }
  MEMO_.rIndex = { list: list, byKey: byKey };
  return MEMO_.rIndex;
}

/** Reads full records for index entries, batching nearby rows into one range read. */
function readRecords_(entries) {
  if (!entries || !entries.length) return [];
  const sh = sheet_(SH_REPORTS);
  const want = {};
  entries.forEach((e) => { want[e.row] = true; });
  const rows = Object.keys(want).map(Number).sort((a, b) => a - b);
  const blocks = [];
  let start = rows[0], end = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] - end <= 200) end = rows[i];
    else { blocks.push([start, end]); start = end = rows[i]; }
  }
  blocks.push([start, end]);
  const out = [];
  blocks.forEach((b) => {
    const vals = sh.getRange(b[0], 1, b[1] - b[0] + 1, REPORT_FIXED_COLS_).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (!want[b[0] + i]) continue;
      const rec = parseReportRow_(vals[i], b[0] + i);
      if (rec) out.push(rec);
    }
  });
  return out;
}

function findReport_(date, schoolId) {
  const e = reportIndex_().byKey[date + '|' + schoolId];
  if (!e) return null;
  const recs = readRecords_([e]);
  return recs.length && recs[0].key === e.key ? recs[0] : null;
}

/** Insert or update a report row (inside the lock). `mirror` also writes the readable columns. */
function saveReport_(rec, mirror) {
  const sh = sheet_(SH_REPORTS);
  let row = rec.row;
  if (!row) {
    row = Math.max(sh.getLastRow(), 1) + 1;
    ensureRows_(sh, row);
  }
  writeBlock_(sh, row, 1, [reportFixedRow_(rec)]);
  rec.row = row;
  if (mirror) writeMirror_(sh, row, rec.answers);
  MEMO_.rIndex = null;
  return rec;
}

/** Writes the fixed columns of several records, one setValues per run of adjacent rows. */
function saveReportsFixed_(recs) {
  if (!recs.length) return;
  const sh = sheet_(SH_REPORTS);
  const sorted = recs.slice().sort((a, b) => a.row - b.row);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].row === sorted[j].row + 1) j++;
    writeBlock_(sh, sorted[i].row, 1, sorted.slice(i, j + 1).map(reportFixedRow_));
    i = j + 1;
  }
  MEMO_.rIndex = null;
}

/**
 * Mirror columns for the CURRENT fields; columns of removed fields are left untouched. These columns
 * are only a readable copy (answersJson in column M is authoritative and already written), so a
 * failure here is logged and never fails the submission.
 */
function writeMirror_(sh, row, answers) {
  try {
    const fields = fields_();
    const map = ensureFieldCols_(sh, fields);
    const cells = fieldColumns_(fields)
      .filter((c) => map[c.key] > REPORT_FIXED_COLS_)
      .map((c) => ({ col: map[c.key], value: mirrorValue_(c, answers) }))
      .sort((a, b) => a.col - b.col);
    if (!cells.length) return;
    ensureCols_(sh, cells[cells.length - 1].col);   // a deleted column must not push writes off the sheet
    let i = 0;
    while (i < cells.length) {
      let j = i;
      while (j + 1 < cells.length && cells[j + 1].col === cells[j].col + 1) j++;
      writeBlock_(sh, row, cells[i].col, [cells.slice(i, j + 1).map((c) => c.value)]);
      i = j + 1;
    }
  } catch (e) {
    try { console.error('writeMirror_: ' + ((e && e.stack) || e)); } catch (ignore) { /* no console */ }
  }
}

/**
 * The column map for `fields`, verified against the header row: when a column was inserted,
 * deleted or moved by hand, the keys whose header no longer matches are dropped and found again
 * by their header text (syncFieldCols_), so values never land under the wrong heading.
 */
function ensureFieldCols_(sh, fields) {
  const map = fieldColsMap_();
  const specs = fieldColumns_(fields);
  if (!specs.every((c) => map[c.key] > REPORT_FIXED_COLS_)) return syncFieldCols_(sh, fields);
  if (MEMO_.mirrorOk) return map;
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map((v) => cleanText_(cellStr_(v)));
  const stale = specs.filter((c) => header[map[c.key] - 1] !== cleanText_(c.header));
  if (!stale.length) { MEMO_.mirrorOk = true; return map; }
  const out = syncFieldCols_(sh, fields, stale.map((c) => c.key));
  MEMO_.mirrorOk = true;
  return out;
}

/**
 * Keeps the readable mirror columns in sync with the form (inside the lock):
 * new key → append a column (or re-use an unmapped column with the same header),
 * renamed field → update the header text, removed field → its column stays.
 */
function syncFieldCols_(sh, fields, staleKeys) {
  return withLock_(() => {
    const map = clone_(fieldColsMap_());
    (staleKeys || []).forEach((k) => { delete map[k]; });   // header moved: find the column again by its text
    const specs = fieldColumns_(fields);
    const lastCol = Math.max(sh.getLastColumn(), REPORT_FIXED_COLS_);
    const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(cellStr_);
    const usedCols = {};
    const current = toSet_(specs.map((sp) => sp.key));
    const fieldIds = toSet_((fields || []).map((f) => f.id));
    Object.keys(map).forEach((k) => {
      if (map[k] > REPORT_FIXED_COLS_ && map[k] <= lastCol && !usedCols[map[k]]) usedCols[map[k]] = k;
      else delete map[k];
    });
    // A column still mapped to a field that no longer exists may be re-used by a NEW key with the
    // same header (a deleted question added again keeps writing under its old heading).
    const retiredCol = (c) => {
      const k = usedCols[c];
      return !!k && !current[k] && !fieldIds[String(k).split('.')[0]];
    };
    let next = lastCol;
    Object.keys(usedCols).forEach((c) => { next = Math.max(next, Number(c)); });
    next += 1;
    const newCols = [];
    const headerChanges = {};
    let changed = false;
    specs.forEach((sp) => {
      let col = map[sp.key];
      if (!(col > REPORT_FIXED_COLS_)) {
        // Re-use an orphan column carrying the same header (copies, resets, lost mapping).
        for (let c = REPORT_FIXED_COLS_ + 1; c <= lastCol; c++) {
          if ((!usedCols[c] || retiredCol(c)) && cleanText_(header[c - 1]) === cleanText_(sp.header)) {
            if (usedCols[c]) delete map[usedCols[c]];
            col = c;
            break;
          }
        }
        if (!(col > REPORT_FIXED_COLS_)) { col = next++; newCols.push({ col: col, num: sp.num }); }
        map[sp.key] = col;
        usedCols[col] = sp.key;
        changed = true;
      }
      if (header[col - 1] !== sp.header) headerChanges[col] = sp.header;
    });
    const maxCol = Math.max(lastCol, next - 1);
    if (newCols.length) {
      ensureCols_(sh, maxCol);
      const rows = Math.max(sh.getMaxRows() - 1, 1);
      newCols.forEach((c) => {
        sh.getRange(2, c.col, rows, 1).setNumberFormat(c.num ? '0' : '@');
        try { sh.setColumnWidth(c.col, c.num ? 120 : 170); } catch (e) { /* ignore */ }
      });
    }
    const changedCols = Object.keys(headerChanges).map(Number);
    if (changedCols.length) {
      const width = Math.max(header.length, Math.max.apply(null, changedCols));
      const row = [];
      for (let c = 1; c <= width; c++) row.push(headerChanges[c] !== undefined ? headerChanges[c] : (header[c - 1] || ''));
      ensureCols_(sh, width);
      writeBlock_(sh, 1, 1, [row]);
      styleHeader_(sh, width);
    }
    if (changed) setBigProp_('fieldCols', JSON.stringify(map));
    MEMO_.fieldCols = map;
    return map;
  });
}

// ---------- activity log ----------

/** Appends to «السجل» (inside the lock) and trims it to the newest 2000 rows. Never throws. */
function log_(action, details) {
  try {
    withLock_(() => {
      const sh = sheet_(SH_LOG);
      const row = Math.max(sh.getLastRow(), 1) + 1;
      ensureRows_(sh, row);
      writeBlock_(sh, row, 1, [[nowTs_(), String(action || '').slice(0, 100), String(details || '').slice(0, 1000)]]);
      if (row - 1 > LIMITS_.logTrimAt) sh.deleteRows(2, row - 1 - LIMITS_.logKeep);
    });
  } catch (e) {
    try { console.warn('log failed: ' + e); } catch (ignore) { /* no console */ }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 6. Photos (Drive — only the folder and files this app creates)
// ═══════════════════════════════════════════════════════════════════════════

/** The evidence folder; created (or re-created when missing/trashed) on demand. */
function photosFolder_(create) {
  const tryOpen = (id) => {
    if (!id) return null;
    try {
      const f = DriveApp.getFolderById(id);
      return f && !f.isTrashed() ? f : null;
    } catch (e) { return null; }
  };
  const existing = tryOpen(cfg_().photosFolderId);
  if (existing || !create) return existing;
  return withLock_(() => {
    const again = tryOpen(cfg_().photosFolderId);
    if (again) return again;
    // A trashed folder is replaced, but its id is remembered: once restored from the trash, the
    // evidence photos in it stay viewable in the dashboard (api_photo accepts every known folder).
    const prev = cfg_().photosFolderId;
    const oldIds = (Array.isArray(cfg_().photosFolderIdsOld) ? cfg_().photosFolderIdsOld : [])
      .filter((x) => x && x !== prev);
    const folder = DriveApp.createFolder(PHOTOS_FOLDER_NAME);
    saveCfg_({ photosFolderId: folder.getId(), photosFolderIdsOld: prev ? oldIds.concat([prev]).slice(-20) : oldIds });
    return folder;
  });
}

function photosFolderUrl_() { return driveFolderUrl_(cfg_().photosFolderId); }

/**
 * The owner's Google storage ({used, limit} in bytes, cached 6 h) or null. Evidence photos live in
 * the supervisor's own Drive (15 GB shared with Gmail on free accounts), so the dashboard warns early.
 */
function driveStorage_() {
  try {
    const hit = cache_().get('storage');
    if (hit) return JSON.parse(hit);
    const used = DriveApp.getStorageUsed();
    const limit = DriveApp.getStorageLimit();
    const out = isNum_(used) && isNum_(limit) && limit > 0 ? { used: used, limit: limit } : null;
    if (out) cache_().put('storage', JSON.stringify(out), LIMITS_.counterTtlSec);
    return out;
  } catch (e) {
    return null;
  }
}

/** Ids of every evidence folder this app created (current first). */
function photoFolderIds_() {
  const c = cfg_();
  return [c.photosFolderId].concat(Array.isArray(c.photosFolderIdsOld) ? c.photosFolderIdsOld : [])
    .filter((x) => typeof x === 'string' && x);
}

/**
 * Is the file inside one of the app's evidence folders? With the full Drive scope getFileById can
 * reach any file of the owner, so the folder — not only the file name — is what proves it is ours.
 */
function inPhotosFolder_(file) {
  const allowed = toSet_(photoFolderIds_());
  if (!Object.keys(allowed).length) return false;
  try {
    const it = file.getParents();
    while (it.hasNext()) { if (allowed[it.next().getId()]) return true; }
  } catch (e) { /* no parents visible */ }
  return false;
}

/** Does this Drive file belong to the school (app folder, name `<date>_<schoolId>_…`, not trashed)? */
function fileBelongsTo_(file, schoolId) {
  try {
    if (file.isTrashed()) return false;
  } catch (e) { /* treat as not trashed */ }
  const name = String(file.getName() || '');
  return /^\d{4}-\d{2}-\d{2}_/.test(name) && name.indexOf('_' + schoolId + '_') > 0 && inPhotosFolder_(file);
}

/** {id, name, size, mime, file} for a photo uploaded by this school, else null. */
function verifySchoolPhoto_(id, schoolId) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
  let file;
  try { file = DriveApp.getFileById(id); } catch (e) { return null; }
  if (!file || !fileBelongsTo_(file, schoolId)) return null;
  return { id: file.getId(), name: file.getName(), size: file.getSize(), mime: file.getMimeType(), file: file };
}

/** First bytes match the declared image type. */
function imageMagicOk_(bytes, mime) {
  const b = (i) => (bytes[i] === undefined ? -1 : bytes[i] & 0xFF);
  if (mime === 'image/jpeg') return b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF;
  if (mime === 'image/png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47;
  if (mime === 'image/webp') {
    return b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
      b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50;
  }
  return false;
}

function fileDataUrl_(file) {
  const size = file.getSize();
  if (size > LIMITS_.photoMaxBytes) fail_('حجم الصورة أكبر من المسموح لعرضها.');
  const blob = file.getBlob();
  const mime = file.getMimeType() || blob.getContentType() || 'image/jpeg';
  return 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/**
 * Which of `ids` are referenced by saved reports of a school (optionally excluding one report).
 * A server-side TextFinder on the answers-JSON column finds the few candidate rows, so a photo
 * removal never reads the whole sheet under the lock; candidates are then confirmed by parsing.
 */
function photoRefs_(schoolId, exceptKey, ids) {
  const refs = {};
  const want = (ids || []).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id));
  if (!want.length) return refs;
  const sh = sheet_(SH_REPORTS);
  const last = sh.getLastRow();
  if (last < 2) return refs;
  const byRow = {};
  reportIndex_().list.forEach((e) => { byRow[e.row] = e; });
  const col = sh.getRange(2, REPORT_FIXED_COLS_, last - 1, 1);
  const cand = {};
  want.forEach((id) => {
    col.createTextFinder(id).matchCase(true).findAll().forEach((cell) => {
      const e = byRow[cell.getRow()];
      if (e && e.schoolId === schoolId && e.key !== exceptKey) cand[e.row] = e;
    });
  });
  const wanted = toSet_(want);
  readRecords_(Object.keys(cand).map((r) => cand[r]))
    .forEach((r) => { photoIds_(r.answers).forEach((id) => { if (wanted[id]) refs[id] = true; }); });
  return refs;
}

/** Trashes photos removed from a report when no other report of the school uses them. Best effort. */
function cleanupPhotos_(schoolId, ids, exceptKey) {
  if (!ids || !ids.length) return;
  try {
    withLock_(() => {
      const refs = photoRefs_(schoolId, exceptKey, ids);
      ids.forEach((id) => {
        if (refs[id]) return;
        try {
          const f = DriveApp.getFileById(id);
          if (fileBelongsTo_(f, schoolId)) f.setTrashed(true);
        } catch (e) { /* already gone */ }
      });
    });
  } catch (e) {
    try { console.warn('photo cleanup failed: ' + e); } catch (ignore) { /* no console */ }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 7. Bootstrap & routing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * First step of every entry point.
 *  • Copy detection: if cfg.ssId exists and differs from the active spreadsheet,
 *    this is a fresh copy of someone else's file → wipe Script Properties.
 *    A standalone script (no bound spreadsheet) has no such signal: there a different
 *    effective user than the stored owner means a copied project → wipe as well (its cfg.ssId
 *    points at the original owner's spreadsheet, which ss_() would otherwise keep using).
 *  • Records ssId and (web-app / trigger contexts only) the owner's email.
 *  • Lazily creates the data sheets (and, standalone, the data spreadsheet — see ss_()).
 * opts.menu = true for spreadsheet-menu contexts (the clicking user may be an
 * editor, not the owner, so the owner email is never captured or compared there).
 */
function bootstrap_(opts) {
  MEMO_ = {};
  const o = opts || {};
  let stored = readJsonProp_('cfg', {});
  if (!isObj_(stored)) stored = {};

  let active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  const activeId = active ? active.getId() : '';
  if (active) MEMO_.ss = active;

  let email = '';
  if (!o.menu) {
    try { email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { email = ''; }
  }
  const copiedBound = !!(stored.ssId && activeId && stored.ssId !== activeId);
  const copiedStandalone = !active && !!email && !!stored.ownerEmail &&
    String(stored.ownerEmail).trim().toLowerCase() !== email;
  if (copiedBound || copiedStandalone) {
    withLock_(() => props_().deleteAllProperties());
    stored = {};
    MEMO_ = active ? { ss: active } : {};
  }

  const patch = {};
  if (activeId && stored.ssId !== activeId) patch.ssId = activeId;
  if (!stored.ownerEmail && email) patch.ownerEmail = email;
  if (stored.version !== APP_VERSION) patch.version = APP_VERSION;
  if (Object.keys(patch).length) saveCfg_(patch);

  ensureSheets_();
}

/** Public, pre-auth status for the admin page (leaks nothing else). */
function publicStatus_() {
  const c = cfg_();
  return {
    setupDone: !!c.setupDone,
    ownerEmailMasked: maskEmail_(c.ownerEmail),
    supervisorName: c.setupDone ? (c.supervisor.name || '') : '',
    deployed: !!baseUrl_(),
    devMode: devMode_()
  };
}

/**
 * Saves the deployment URL the first time the supervisor page is opened from a real deployment
 * ('…/exec'), so links stay right even where getUrl() is unreliable (menu, triggers, '/dev').
 */
function captureWebAppUrl_() {
  try {
    if (cfg_().webAppUrl) return;
    const u = cleanWebAppUrl_(serviceUrl_());
    if (!u) return;
    withLock_(() => { if (!cfg_().webAppUrl) saveCfg_({ webAppUrl: u }); });
    MEMO_.baseUrl = undefined;
  } catch (e) { /* optional */ }
}

/**
 * Web-app entry: ?s=<token> (school form; &d=<yyyy-MM-dd> opens a late / correction report of that
 * day when allowed), ?f=all (school picker), otherwise the supervisor page.
 */
function doGet(e) {
  try {
    bootstrap_();
    const p = (e && e.parameter) || {};
    const c = cfg_();
    const base = { appName: APP_NAME, version: APP_VERSION, systemTitle: c.systemTitle };
    if (p.s) {
      const token = cleanToken_(p.s);
      const d = typeof p.d === 'string' && isIsoDate_(p.d.trim()) ? p.d.trim() : null;
      let form = schoolFormData_(token, d);
      if (d && !form.ok && form.code === 'NOT_EDITABLE') form = schoolFormData_(token, null);   // that day is closed → today
      const boot = Object.assign({ page: 'school', mode: 'form' }, base, { token: token, form: form });
      const title = (form.ok && form.school ? form.school.name + ' — ' : '') + c.systemTitle;
      return renderPage_('School', boot, title);
    }
    if (p.f === 'all') {
      const boot = Object.assign({ page: 'school', mode: 'picker' }, base, { picker: pickerData_() });
      return renderPage_('School', boot, c.systemTitle);
    }
    captureWebAppUrl_();
    const boot = Object.assign({ page: 'admin' }, base, { status: publicStatus_() });
    return renderPage_('Admin', boot, c.systemTitle + ' — لوحة المشرف');
  } catch (err) {
    try { console.error((err && err.stack) || String(err)); } catch (ignore) { /* no console */ }
    const perm = permMessage_(err);
    return errorPage_(perm ? 'لا يمكن فتح الصفحة الآن: ' + perm : '');
  }
}

/**
 * HTML sources come from the project's .html files — or, in a single-file bundle, from the global
 * NABD_EMBEDDED_FILES_ map ({ name: html }) that a bundler appends. One helper for every load.
 */
function embeddedHtml_(name) {
  const files = typeof NABD_EMBEDDED_FILES_ !== 'undefined' && NABD_EMBEDDED_FILES_ ? NABD_EMBEDDED_FILES_ : null;
  if (!files) return null;
  const n = String(name);
  if (Object.prototype.hasOwnProperty.call(files, n)) return String(files[n]);
  if (Object.prototype.hasOwnProperty.call(files, n + '.html')) return String(files[n + '.html']);
  return null;
}
/** An HtmlTemplate for a page (embedded source when bundled, else the project file). */
function htmlTemplate_(name) {
  const src = embeddedHtml_(name);
  return src !== null ? HtmlService.createTemplate(src) : HtmlService.createTemplateFromFile(name);
}
/** The raw content of a partial (embedded source when bundled, else the project file). */
function htmlFile_(name) {
  const src = embeddedHtml_(name);
  return src !== null ? src : HtmlService.createHtmlOutputFromFile(name).getContent();
}

function renderPage_(file, boot, title) {
  const t = htmlTemplate_(file);
  t.bootJson = safeJson_(boot);
  return t.evaluate()
    .setTitle(String(title).slice(0, 200))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function errorPage_(text) {
  const body = text ? escHtml_(text)
    : 'تعذّر فتح الصفحة الآن بسبب خطأ غير متوقع.<br>حدّث الصفحة بعد قليل، وإذا تكرر الأمر تواصل مع المشرف.';
  const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#F5F7F8;font-family:Tahoma,"Segoe UI",sans-serif;color:#10222B;padding:16px;box-sizing:border-box}' +
    '.c{max-width:440px;background:#fff;border:1px solid #E2E8EA;border-radius:18px;padding:28px 24px;' +
    'text-align:center;box-shadow:0 4px 16px rgba(16,34,43,.08)}h1{font-size:20px;margin:0 0 8px;color:#084F42}' +
    'p{margin:0;color:#3E5360;line-height:1.8}</style></head><body><div class="c">' +
    '<h1>' + escHtml_(APP_NAME) + '</h1><p>' + body + '</p></div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Includes a shared HTML partial (Styles / Common) inside a page template. */
function include(name) {
  const n = String(name || '');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(n)) throw new Error('ملف غير معروف.');
  return htmlFile_(n);
}

/** Keeps only token characters (also drops punctuation messaging apps glue to links). */
function cleanToken_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
}


// ═══════════════════════════════════════════════════════════════════════════
// 8. School-side API (no session — authorised by the school's private token)
// ═══════════════════════════════════════════════════════════════════════════

function formError_(code) {
  const msg = { BAD_LINK: MSG_.BAD_LINK, INACTIVE: MSG_.INACTIVE, NOT_SETUP: MSG_.NOT_SETUP_SCHOOL,
    NOT_EDITABLE: MSG_.NOT_EDITABLE }[code] || MSG_.UNEXPECTED;
  return { ok: false, code: code, error: msg };
}

/** Active school for a token, or a fail_ with the matching Arabic message. */
function requireSchool_(token, previewMsg) {
  if (!cfg_().setupDone) fail_(MSG_.NOT_SETUP_SCHOOL);
  if (token === PREVIEW_TOKEN) fail_(previewMsg || MSG_.PREVIEW);
  const s = schoolByToken_(token);
  if (!s) fail_(MSG_.BAD_LINK);
  if (!s.active) fail_(MSG_.INACTIVE);
  return s;
}

/** The school form payload (BOOT.form / api_schoolForm). Never throws. */
function schoolFormData_(token, date) {
  try {
    const c = cfg_();
    const today = todayStr_();
    const now = nowHM_();
    const fields = fields_();
    const hs = toSet_(holidays_());
    const deadline = c.schedule.deadline;
    const pastDeadline = pastDeadline_(c, today, now, hs);   // the deadline only applies on workdays
    const reviewEnabled = !!c.review.enabled;
    const common = {
      supervisor: { name: c.supervisor.name || '', title: c.supervisor.title || DEFAULT_SUPERVISOR_TITLE },
      systemTitle: c.systemTitle,
      fields: fields,
      today: today,
      now: now,
      deadline: deadline,
      allowLate: !!c.schedule.allowLate,
      reviewEnabled: reviewEnabled
    };

    if (token === PREVIEW_TOKEN) {
      return Object.assign({ ok: true, preview: true,
        school: { name: 'مدرسة تجريبية (معاينة)', principal: '', students: 400, teachers: 30, staff: 8, stage: '' }
      }, common, {
        date: today,
        isWorkday: isWorkday_(today, c.schedule.workdays, hs),
        isHoliday: !!hs[today],
        state: pastDeadline ? 'late' : 'open',
        existing: null,
        canEdit: true,
        returned: [],
        missingDays: []
      });
    }

    if (!c.setupDone) return formError_('NOT_SETUP');
    const s = schoolByToken_(token);
    if (!s) return formError_('BAD_LINK');
    if (!s.active) return formError_('INACTIVE');

    const idx = reportIndex_();
    const missing = missingDays_(s, c, today, hs, idx);
    let reportDate = today, state, existing = null, canEdit;
    if (date && date !== today) {
      if (!isIsoDate_(date) || date > today) return formError_('NOT_EDITABLE');
      const rec = findReport_(date, s.id);
      if (rec && rec.status === 'returned') {
        state = 'correction';                     // returned for correction: always editable
        existing = rec;
      } else if (!rec && missing.indexOf(date) >= 0) {
        state = 'backfill';                       // a missed workday inside the late-reporting window
      } else {
        return formError_('NOT_EDITABLE');
      }
      reportDate = date;
      canEdit = true;
    } else {
      existing = findReport_(today, s.id);
      state = formState_(pastDeadline, !!c.schedule.allowLate, !!existing);
      canEdit = canEditToday_(existing, { reviewEnabled: reviewEnabled, allowLate: !!c.schedule.allowLate,
        pastDeadline: pastDeadline });
    }

    const retEntries = idx.list.filter((e) => e.schoolId === s.id && e.status === 'returned')
      .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
    const returned = readRecords_(retEntries)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((r) => ({ date: r.date, reviewNote: r.reviewNote, reviewedAt: r.reviewedAt }));

    return Object.assign({ ok: true, preview: false,
      school: { name: s.name, principal: s.principal, students: s.students, teachers: s.teachers, staff: s.staff,
        stage: s.stage }
    }, common, {
      date: reportDate,
      isWorkday: isWorkday_(reportDate, c.schedule.workdays, hs),
      isHoliday: !!hs[reportDate],
      state: state,
      existing: existing ? reportOut_(existing, fields, retiredKpis_()) : null,
      canEdit: canEdit,
      returned: returned,
      missingDays: missing
    });
  } catch (e) {
    return { ok: false, code: 'ERROR', error: schoolErrorText_(e) };
  }
}

/** Principal-facing text for an error (layout problems are the supervisor's to fix). */
function schoolErrorText_(e) {
  if (e && e.nabdLayout) return MSG_.UNAVAILABLE;
  if (e && e.nabdUser) return e.message;
  try { console.error((e && e.stack) || String(e)); } catch (ignore) { /* no console */ }
  return permMessage_(e) || MSG_.UNEXPECTED;
}

/** Is today's deadline over? Never on non-workdays (holidays, weekends): nothing is due then. */
function pastDeadline_(c, today, now, hs) {
  return now > c.schedule.deadline && isWorkday_(today, c.schedule.workdays, hs || toSet_(holidays_()));
}

/** Late-reporting window size (schedule.backfillDays, 0–7). */
function backfillDays_(c) {
  return Math.max(0, Math.min(7, toInt_(c.schedule.backfillDays, 0)));
}

/**
 * Past workdays (newest first) the school may still report: inside the last `backfillDays` workdays,
 * on or after the day it was first due, and with no report yet.
 */
function missingDays_(school, c, today, hs, idx) {
  const first = firstDueDate_(school, c.schedule.deadline);
  return backfillDates_(today, c.schedule.workdays, hs, backfillDays_(c))
    .filter((d) => (!first || d >= first) && !idx.byKey[d + '|' + school.id]);
}

/** School list for the general link (?f=all). Never throws. */
function pickerData_() {
  try {
    const c = cfg_();
    if (!c.setupDone) return { ok: false, code: 'NOT_SETUP', error: MSG_.NOT_SETUP_SCHOOL };
    if (!c.links.generalEnabled) return { ok: false, code: 'DISABLED', error: MSG_.GENERAL_OFF };
    const schools = readSchools_().filter((s) => s.active)
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => cmpName_(a.name, b.name));
    return { ok: true, supervisor: { name: c.supervisor.name || '', title: c.supervisor.title || '' }, schools: schools };
  } catch (e) {
    return { ok: false, code: 'ERROR', error: schoolErrorText_(e) };
  }
}

function api_schoolForm(schoolToken, date) {
  return run_(() => {
    const d = typeof date === 'string' && date.trim() ? date.trim().slice(0, 10) : null;
    return schoolFormData_(cleanToken_(schoolToken), d);
  }, { school: true });
}

/** General link: exchange (schoolId, 4-digit school code) for the private token. */
function api_resolveSchool(schoolId, pin) {
  return run_(() => {
    const c = cfg_();
    if (!c.setupDone) fail_(MSG_.NOT_SETUP_SCHOOL);
    if (!c.links.generalEnabled) fail_(MSG_.GENERAL_OFF);
    const id = typeof schoolId === 'string' ? schoolId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) fail_('اختر مدرستك من القائمة.');
    const code = normDigits_(typeof pin === 'string' || typeof pin === 'number' ? String(pin) : '').trim();
    if (!/^\d{4}$/.test(code)) fail_('رمز المدرسة 4 أرقام.');
    const key = 'pin:' + id;
    if (cacheInt_(key) >= LIMITS_.pinTries) fail_(MSG_.PIN_LOCKED);
    const s = schoolById_(id);
    if (!s || !s.active) fail_('المدرسة غير متاحة. حدّث الصفحة واختر مدرستك من جديد.');
    if (!safeEq_(s.pin, code)) {
      withLock_(() => cacheIncr_(key, LIMITS_.pinWindowSec));
      fail_(MSG_.PIN_WRONG);
    }
    return { ok: true, token: s.token };
  }, { school: true });
}

/** Saves one evidence photo (already compressed by the browser) to the photos folder. */
function api_uploadPhoto(schoolToken, payload) {
  return run_(() => {
    const school = requireSchool_(cleanToken_(schoolToken), 'وضع المعاينة — لا يتم رفع الصور.');
    if (!isObj_(payload)) fail_('بيانات الصورة غير صالحة.');
    const mime = String(payload.mime || '').toLowerCase().trim();
    if (!PHOTO_MIMES_[mime]) fail_('نوع الملف غير مدعوم. ارفع صورة بصيغة JPG أو PNG أو WEBP.');
    let b64 = typeof payload.base64 === 'string' ? payload.base64 : '';
    if (b64.slice(0, 5) === 'data:') b64 = b64.slice(b64.indexOf(',') + 1);
    // Size check BEFORE decoding (base64 length × 3/4 ≈ bytes).
    if (b64.length * 3 / 4 > LIMITS_.photoMaxBytes + 8192) fail_('حجم الصورة أكبر من 3 ميجابايت. اختر صورة أصغر.');
    b64 = b64.replace(/\s+/g, '');
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail_('ملف الصورة تالف. جرّب صورة أخرى.');

    const today = todayStr_();
    const upKey = 'up:' + school.id + ':' + today;
    if (cacheInt_(upKey) >= LIMITS_.uploadsPerDay) {
      fail_('تجاوزت الحد اليومي لرفع الصور (' + LIMITS_.uploadsPerDay + ' صورة). تواصل مع المشرف.');
    }
    let bytes;
    try { bytes = Utilities.base64Decode(b64); } catch (e) { fail_('ملف الصورة تالف. جرّب صورة أخرى.'); }
    if (!bytes || !bytes.length) fail_('ملف الصورة فارغ.');
    if (bytes.length > LIMITS_.photoMaxBytes) fail_('حجم الصورة أكبر من 3 ميجابايت. اختر صورة أصغر.');
    if (!imageMagicOk_(bytes, mime)) fail_('الملف المختار ليس صورة صالحة.');

    // Rate counter + folder resolution under the lock; the Drive upload itself
    // runs outside it so principals uploading at the same time do not queue.
    const folder = withLock_(() => {
      if (cacheInt_(upKey) >= LIMITS_.uploadsPerDay) {
        fail_('تجاوزت الحد اليومي لرفع الصور (' + LIMITS_.uploadsPerDay + ' صورة). تواصل مع المشرف.');
      }
      cacheIncr_(upKey, LIMITS_.counterTtlSec);
      return photosFolder_(true);
    });
    const fileName = today + '_' + school.id + '_' + randStr_(6, LOWER_ALNUM_) + '.' + PHOTO_MIMES_[mime];
    let file;
    try {
      file = folder.createFile(Utilities.newBlob(bytes, mime, fileName));
    } catch (e) {
      if (/quota|storage|limit|exceed/i.test(String((e && e.message) || e))) {
        try { console.error('createFile failed: ' + e); } catch (ignore) { /* no console */ }
        fail_(MSG_.DRIVE_FULL);
      }
      throw e;
    }
    try { file.setDescription(school.name + ' — ' + today); } catch (e) { /* optional */ }
    return {
      ok: true,
      photo: {
        id: file.getId(),
        name: cleanText_(payload.name).slice(0, 100) || fileName,
        w: Math.max(0, Math.min(20000, toInt_(payload.w, 0))),
        h: Math.max(0, Math.min(20000, toInt_(payload.h, 0))),
        size: bytes.length
      }
    };
  }, { school: true });
}

/**
 * Removes a photo the school no longer wants. Photos still referenced by a saved
 * report are kept (they are trashed automatically once the edited report is
 * re-submitted without them), so an abandoned edit never breaks saved evidence.
 */
function api_discardPhoto(schoolToken, fileId) {
  return run_(() => {
    const school = requireSchool_(cleanToken_(schoolToken));
    const id = typeof fileId === 'string' ? fileId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail_(MSG_.PHOTO_NOT_FOUND);
    let file;
    try { file = DriveApp.getFileById(id); } catch (e) { return { ok: true }; }
    if (!fileBelongsTo_(file, school.id)) {
      try { if (file.isTrashed()) return { ok: true }; } catch (e) { /* ignore */ }
      fail_('لا يمكن حذف هذه الصورة.');
    }
    withLock_(() => {
      if (photoRefs_(school.id, null, [id])[id]) return;   // still part of a saved report → kept
      try { file.setTrashed(true); } catch (e) { /* best effort */ }
    });
    return { ok: true };
  }, { school: true });
}

/** A photo of this school as a data URL (for thumbnails on the school page). */
function api_schoolPhoto(schoolToken, fileId) {
  return run_(() => {
    const school = requireSchool_(cleanToken_(schoolToken));
    const v = verifySchoolPhoto_(typeof fileId === 'string' ? fileId.trim() : '', school.id);
    if (!v) fail_(MSG_.PHOTO_NOT_FOUND);
    return { ok: true, dataUrl: fileDataUrl_(v.file) };
  }, { school: true });
}

/** Submit (or edit / correct) the school's daily report. */
function api_submitReport(schoolToken, payload) {
  return run_(() => {
    const school = requireSchool_(cleanToken_(schoolToken), 'وضع المعاينة — لا يتم إرسال أي تقرير.');
    if (!isObj_(payload)) fail_('بيانات التقرير غير صالحة.');
    const filledBy = cleanText_(payload.filledBy);
    if (filledBy.length < 2) fail_('اكتب اسم من يعبّئ التقرير (حرفان على الأقل).');
    if (filledBy.length > 80) fail_('اسم من يعبّئ التقرير أطول من 80 حرفًا.');

    const today = todayStr_();
    let date = today;
    const pd = typeof payload.date === 'string' ? payload.date.trim() : '';
    if (pd && pd !== today) {
      if (!isIsoDate_(pd) || pd > today) fail_(MSG_.NOT_EDITABLE);
      date = pd;
    }
    const subKey = 'sub:' + school.id + ':' + today;
    if (cacheInt_(subKey) >= LIMITS_.submitsPerDay) {
      fail_('تجاوزت الحد اليومي لمرات الإرسال. تواصل مع المشرف.');
    }
    // Edit rules first (cheap and clearer than a field error); re-checked inside the lock.
    // A past date is accepted for a report returned for correction, or — with no report yet — for a
    // missed workday inside the late-reporting window (schedule.backfillDays).
    const checkEditable = (c, old) => {
      if (date !== today) {
        if (old && old.status === 'returned') return;
        if (!old && missingDays_(school, c, today, toSet_(holidays_()), reportIndex_()).indexOf(date) >= 0) return;
        fail_(MSG_.NOT_EDITABLE);
      }
      if (!canEditToday_(old, { reviewEnabled: !!c.review.enabled, allowLate: !!c.schedule.allowLate,
        pastDeadline: pastDeadline_(c, today, nowHM_()) })) {
        if (old && old.status === 'approved') fail_(MSG_.APPROVED_LOCKED);
        fail_(MSG_.CLOSED);
      }
    };
    checkEditable(cfg_(), findReport_(date, school.id));

    const fields = fields_();
    const answers = validateAnswers_(fields, payload.answers, (id) => verifySchoolPhoto_(id, school.id));
    if (JSON.stringify(answers).length > LIMITS_.answersJsonMax) {
      fail_('حجم البيانات أكبر من المسموح. اختصر النصوص الطويلة.');
    }

    const result = withLock_(() => {
      const c = cfg_();
      const now = nowHM_();
      const ts = nowTs_();
      const reviewEnabled = !!c.review.enabled;
      const old = findReport_(date, school.id);
      checkEditable(c, old);
      // Late: a missed day sent afterwards, or today's report after the deadline (never on an off day).
      const late = date !== today || pastDeadline_(c, today, now);
      const rec = old ? Object.assign({}, old) : {
        row: null, key: date + '|' + school.id, date: date, schoolId: school.id, submittedAt: ts,
        late: late, edits: 0, reviewNote: '', reviewedAt: ''
      };
      if (old) rec.edits = (old.edits || 0) + 1;
      rec.schoolName = school.name;
      rec.updatedAt = ts;
      rec.filledBy = filledBy;
      rec.answers = answers;
      if (reviewEnabled) {
        rec.status = 'pending';          // a corrected report keeps its reviewNote («تم التصحيح بعد ملاحظة»)
      } else {
        rec.status = 'approved';         // auto-approved: reviewedAt stays empty
        rec.reviewedAt = '';
      }
      saveReport_(rec, true);
      cacheIncr_(subKey, LIMITS_.counterTtlSec);
      const keep = toSet_(photoIds_(answers));
      const removed = old ? photoIds_(old.answers).filter((id) => !keep[id]) : [];
      return { rec: rec, removed: removed };
    });

    cleanupPhotos_(school.id, result.removed, result.rec.date + '|' + school.id);
    const receipt = Object.assign(reportOut_(result.rec, fields, retiredKpis_()), { schoolName: school.name });
    return { ok: true, receipt: receipt };
  }, { school: true });
}


// ═══════════════════════════════════════════════════════════════════════════
// 9. Auth & setup API — one-time codes by email, hashed sliding sessions
// ═══════════════════════════════════════════════════════════════════════════

function sessionKey_(token) { return 'sess:' + sha256Hex_(token); }

/** Validates the supervisor session (throws 'AUTH_REQUIRED'); slides expiry every 12 h. */
function requireAuth_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail_('AUTH_REQUIRED');
  const key = sessionKey_(token);
  const p = props_();
  let s = null;
  try { s = JSON.parse(p.getProperty(key) || 'null'); } catch (e) { s = null; }
  const now = Date.now();
  if (!isObj_(s) || !(Number(s.exp) > now)) {
    if (s) withLock_(() => p.deleteProperty(key));
    fail_('AUTH_REQUIRED');
  }
  const ttl = LIMITS_.sessionDays * 86400000;
  if (Number(s.exp) - now < ttl - LIMITS_.sessionSlideMs) {   // last refresh older than 12 h
    s.exp = now + ttl;
    s.last = nowTs_();
    withLock_(() => p.setProperty(key, JSON.stringify(s)));
  }
  return s;
}

function requireSetup_() {
  if (!cfg_().setupDone) fail_('NOT_SETUP');
}

/** Deletes expired sessions and keeps the newest 15 (by last use). Inside the lock. */
function pruneSessions_() {
  const p = props_();
  const all = p.getProperties();
  const now = Date.now();
  const list = [];
  Object.keys(all).forEach((k) => {
    if (k.indexOf('sess:') !== 0) return;
    let s = null;
    try { s = JSON.parse(all[k]); } catch (e) { s = null; }
    if (!isObj_(s) || !(Number(s.exp) > now)) { p.deleteProperty(k); return; }
    list.push({ k: k, last: String(s.last || s.created || '') });
  });
  list.sort((a, b) => (a.last < b.last ? 1 : (a.last > b.last ? -1 : 0)));
  list.slice(LIMITS_.sessionsMax).forEach((x) => p.deleteProperty(x.k));
}

/** Sends a 6-digit login code to the owner's Gmail. */
function api_requestCode() {
  return run_(() => {
    const c = cfg_();
    if (!c.ownerEmail) {
      // Execute-as-me: the owner's address comes from the userinfo.email permission, not the visitor.
      fail_('تعذّر معرفة بريد صاحب هذه النسخة. ' + MSG_.PERM_MISSING);
    }
    return withLock_(() => {
      const cache = cache_();
      if (cache.get('otp_last')) fail_(MSG_.OTP_COOLDOWN);
      if (windowCount_('otp_hour') >= LIMITS_.otpPerHour) fail_(MSG_.OTP_HOURLY);
      if (windowCount_('otp_6h') >= LIMITS_.otpPer6h) fail_(MSG_.OTP_MANY);
      let quota = 1;
      try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = 1; }
      if (quota < 1) fail_('بلغ حسابك الحد اليومي لإرسال الرسائل من Google. حاول مرة أخرى غدًا.');
      const code = newOtpCode_();
      const record = { h: sha256Hex_(code + ':' + cfg_().ssId), exp: Date.now() + LIMITS_.otpTtlSec * 1000, tries: 0 };
      try {
        MailApp.sendEmail({
          to: c.ownerEmail,
          subject: 'رمز الدخول إلى نبض المدارس: ' + code,
          htmlBody: otpEmailHtml_(code, c),
          body: otpEmailText_(code, c),
          name: APP_NAME
        });
      } catch (e) {
        try { console.error('mail failed: ' + e); } catch (ignore) { /* no console */ }
        // A skipped «send email» permission is not fixed by waiting: say what to do instead.
        if (isPermErr_(e) || scopesMissing_()) fail_(MSG_.PERM_MISSING);
        fail_('تعذّر إرسال الرمز إلى بريدك الآن. حاول مرة أخرى بعد قليل.');
      }
      cache.put('otp', JSON.stringify(record), LIMITS_.otpTtlSec);
      cache.put('otp_last', '1', LIMITS_.otpCooldownSec);
      windowIncr_('otp_hour', 3600);
      windowIncr_('otp_6h', LIMITS_.counterTtlSec);
      return { ok: true, emailMasked: maskEmail_(c.ownerEmail) };
    });
  });
}

/** Verifies the code and opens a 30-day session. */
function api_verifyCode(code, uaLabel) {
  return run_(() => {
    const digits = normDigits_(typeof code === 'string' || typeof code === 'number' ? String(code) : '')
      .replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) fail_('أدخل الرمز المكوّن من 6 أرقام.');
    return withLock_(() => {
      const cache = cache_();
      let otp = null;
      try { otp = JSON.parse(cache.get('otp') || 'null'); } catch (e) { otp = null; }
      const now = Date.now();
      if (!isObj_(otp) || !(Number(otp.exp) > now)) {
        cache.remove('otp');
        fail_(MSG_.OTP_EXPIRED);
      }
      const ssId = cfg_().ssId;
      if (!safeEq_(otp.h, sha256Hex_(digits + ':' + ssId))) {
        otp.tries = (Number(otp.tries) || 0) + 1;
        if (otp.tries >= LIMITS_.otpTries) {
          cache.remove('otp');
          fail_(MSG_.OTP_TOO_MANY);
        }
        cache.put('otp', JSON.stringify(otp), Math.max(1, Math.ceil((Number(otp.exp) - now) / 1000)));
        const left = LIMITS_.otpTries - otp.tries;
        fail_('الرمز غير صحيح. ' + (left === 1 ? 'تبقّت محاولة واحدة.' : (left === 2 ? 'تبقّت محاولتان.' :
          'تبقّت ' + left + ' محاولات.')));
      }
      cache.remove('otp');
      const token = newSessionToken_();
      const ts = nowTs_();
      const ua = cleanText_(uaLabel).slice(0, 60);
      props_().setProperty(sessionKey_(token), JSON.stringify({
        exp: now + LIMITS_.sessionDays * 86400000, created: ts, last: ts, ua: ua
      }));
      pruneSessions_();
      log_('تسجيل دخول', ua || '');
      return { ok: true, token: token };
    });
  });
}

function api_logout(token) {
  return run_(() => {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
      withLock_(() => {
        const key = sessionKey_(token);
        if (props_().getProperty(key)) {
          props_().deleteProperty(key);
          log_('تسجيل خروج', '');
        }
      });
    }
    return { ok: true };
  });
}

function api_logoutAll(token) {
  return run_(() => {
    requireAuth_(token);
    withLock_(() => {
      const p = props_();
      Object.keys(p.getProperties()).forEach((k) => { if (k.indexOf('sess:') === 0) p.deleteProperty(k); });
      log_('خروج من كل الأجهزة', '');
    });
    return { ok: true };
  });
}

/** Supervisor details from user input (partial when `base` is given). */
function validateSupervisor_(raw, base, partial) {
  if (!isObj_(raw)) fail_('بيانات المشرف غير صالحة.');
  const out = clone_(base || DEFAULT_CFG_.supervisor);
  if (!partial || 'name' in raw) {
    const name = cleanText_(raw.name);
    if (name.length < 2) fail_('اكتب اسمك (حرفان على الأقل).');
    if (name.length > 60) fail_('الاسم أطول من 60 حرفًا.');
    out.name = name;
  }
  if (!partial || 'title' in raw) {
    const title = cleanText_(raw.title);
    if (title.length > 60) fail_('المسمّى أطول من 60 حرفًا.');
    out.title = title || DEFAULT_SUPERVISOR_TITLE;
  }
  if (!partial || 'office' in raw) {
    const office = cleanText_(raw.office);
    if (office.length > 80) fail_('اسم الجهة أطول من 80 حرفًا.');
    out.office = office;
  }
  if (!partial || 'phone' in raw) {
    const ph = normalizePhone_(raw.phone);
    if (!ph.ok || ph.value.length > 20) fail_('رقم الجوال غير صحيح. اكتب الأرقام فقط (مثل 0501234567).');
    out.phone = ph.value;
  }
  return out;
}

/** One-time setup wizard result: supervisor info, form preset and (optionally) schools. */
function api_completeSetup(token, data) {
  return run_(() => {
    requireAuth_(token);
    if (cfg_().setupDone) fail_(MSG_.SETUP_DONE);
    if (!isObj_(data)) fail_('بيانات التجهيز غير صالحة.');
    const supervisor = validateSupervisor_(data.supervisor, null, false);
    let systemTitle = cleanText_(data.systemTitle);
    if (systemTitle.length > 60) fail_('اسم النظام أطول من 60 حرفًا.');
    if (systemTitle.length < 2) systemTitle = DEFAULT_SYSTEM_TITLE;
    const preset = PRESETS_[data.preset] ? data.preset : 'standard';
    const webAppUrl = webAppUrlInput_(data.webAppUrl);
    const text = typeof data.schoolsText === 'string' ? data.schoolsText : '';
    if (text.length > 100000) fail_('قائمة المدارس طويلة جدًا.');
    const pre = parseBulkSchools_(text, []);
    if (pre.count > LIMITS_.bulkMaxLines) fail_('الحد الأقصى ' + LIMITS_.bulkMaxLines + ' مدرسة في المرة الواحدة.');

    const added = withLock_(() => {
      if (cfg_().setupDone) fail_(MSG_.SETUP_DONE);
      saveFields_(presetFields_(preset));
      const existing = readSchools_();
      const parsed = parseBulkSchools_(text, existing.map((s) => s.name));
      const fresh = [];
      parsed.items.forEach((it) => {
        fresh.push(newSchool_(existing.concat(fresh), { name: it.name, principal: it.principal, phone: it.phone,
          students: it.students, teachers: it.teachers, staff: it.staff }));
      });
      appendSchools_(fresh);
      const patch = { supervisor: supervisor, systemTitle: systemTitle, setupDone: true, setupAt: nowTs_() };
      if (webAppUrl) patch.webAppUrl = webAppUrl;
      saveCfg_(patch);
      MEMO_.baseUrl = undefined;
      log_('تجهيز النظام', 'النموذج: ' + PRESETS_[preset].label + ' — المدارس: ' + fresh.length);
      return fresh.length;
    });
    try { ensureStartSheet_(); } catch (e) { /* optional */ }
    return { ok: true, added: added };
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// 10. Supervisor API — dashboard, review, reports, statistics
// ═══════════════════════════════════════════════════════════════════════════

function checkDate_(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!isIsoDate_(s)) fail_(MSG_.BAD_DATE);
  return s;
}
function checkSchoolId_(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(s)) fail_(MSG_.SCHOOL_NOT_FOUND);
  return s;
}

function api_bootstrap(token) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const c = cfg_();
    const base = baseUrl_();
    let spreadsheetUrl = null;
    try { spreadsheetUrl = ss_().getUrl(); } catch (e) { spreadsheetUrl = null; }
    return {
      ok: true,
      supervisor: c.supervisor,
      systemTitle: c.systemTitle,
      schedule: c.schedule,
      review: c.review,
      links: c.links,
      alerts: c.alerts,
      digest: c.digest,
      fields: fields_(),
      baseUrl: base,
      generalLink: generalLink_(base),
      devMode: devMode_(),
      spreadsheetUrl: spreadsheetUrl,
      photosFolderUrl: photosFolderUrl_(),
      today: todayStr_(),
      now: nowHM_(),
      ownerEmail: c.ownerEmail,
      version: APP_VERSION,
      schoolsCount: readSchools_().filter((s) => s.active).length,
      storage: driveStorage_()
    };
  });
}

/** Collects sheet data for one date and builds the dashboard (shared by api_day and the digest). */
function dayData_(date) {
  const c = cfg_();
  const fields = fields_();
  const holidays = holidays_();
  const hs = toSet_(holidays);
  const schools = readSchools_();
  const idx = reportIndex_();

  const dayEntries = idx.list.filter((e) => e.date === date);
  const hasReport = toSet_(dayEntries.map((e) => e.schoolId));
  const minDate = addDays_(date, -45);
  const histBySchool = {};
  idx.list.forEach((e) => {
    if (!hasReport[e.schoolId] || e.date >= date || e.date < minDate) return;
    if (!isWorkday_(e.date, c.schedule.workdays, hs)) return;
    (histBySchool[e.schoolId] = histBySchool[e.schoolId] || []).push(e);
  });
  let histEntries = [];
  Object.keys(histBySchool).forEach((id) => {
    histEntries = histEntries.concat(histBySchool[id].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10));
  });

  const reports = {}, snapshots = {}, histPairs = {};
  const retired = retiredKpis_();
  readRecords_(dayEntries.concat(histEntries)).forEach((r) => {
    if (r.date === date) {
      reports[r.schoolId] = reportOut_(r, fields, retired);
      snapshots[r.schoolId] = r.schoolName;
    } else {
      const st = deriveReport_(fields, r.answers, retired).attendance.students;
      if (st && st.absencePct !== null) {
        (histPairs[r.schoolId] = histPairs[r.schoolId] || []).push({ date: r.date, pct: st.absencePct });
      }
    }
  });
  const history = {};   // schoolId → previous students absence % (newest first)
  Object.keys(histPairs).forEach((id) => {
    history[id] = histPairs[id].sort((a, b) => (a.date < b.date ? 1 : -1)).map((x) => x.pct);
  });

  const datesBySchool = {};
  idx.list.forEach((e) => { (datesBySchool[e.schoolId] = datesBySchool[e.schoolId] || {})[e.date] = true; });

  const nameById = {};
  schools.forEach((s) => { nameById[s.id] = s.name; });
  const byNewest = (a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : cmpName_(a.schoolName, b.schoolName)));
  const ref = (e) => ({ date: e.date, schoolId: e.schoolId, schoolName: nameById[e.schoolId] || e.schoolName });
  const pendingOther = idx.list.filter((e) => e.status === 'pending' && e.date !== date)
    .sort(byNewest).slice(0, 50).map(ref);
  // Corrections still owed by schools (returned on another day) — they wait on the school, not on you.
  const returnedOther = idx.list.filter((e) => e.status === 'returned' && e.date !== date)
    .sort(byNewest).slice(0, 50).map(ref);

  const modeField = kpiField_(fields, 'mode');
  return buildDay_({
    date: date,
    today: todayStr_(),
    now: nowHM_(),
    deadline: c.schedule.deadline,
    workdays: c.schedule.workdays,
    holidays: holidays,
    thresholds: c.alerts,
    reviewEnabled: !!c.review.enabled,
    allowLate: !!c.schedule.allowLate,
    backfillDays: backfillDays_(c),
    schools: schools,
    reports: reports,
    snapshots: snapshots,
    history: history,
    datesBySchool: datesBySchool,
    pendingOther: pendingOther,
    returnedOther: returnedOther,
    modeOptions: modeField ? modeField.options : [],
    baseUrl: baseUrl_()
  });
}

function api_day(token, date) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const d = date === undefined || date === null || date === '' ? todayStr_() : checkDate_(date);
    return dayData_(d);
  });
}

/** approve | return (with a note) | reopen (approved → pending). */
function api_review(token, date, schoolId, action, note) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const d = checkDate_(date);
    const sid = checkSchoolId_(schoolId);
    if (['approve', 'return', 'reopen'].indexOf(action) < 0) fail_('إجراء غير معروف.');
    let cleanNote = '';
    if (action === 'return') {
      cleanNote = cleanText_(note, true);
      if (cleanNote.length < 3) fail_('اكتب ملاحظة التصحيح (3 أحرف على الأقل).');
      if (cleanNote.length > 300) fail_('ملاحظة التصحيح أطول من 300 حرف.');
    }
    const rec = withLock_(() => {
      const r = findReport_(d, sid);
      if (!r) fail_(MSG_.REPORT_NOT_FOUND);
      const ts = nowTs_();
      if (action === 'approve') {
        if (r.status !== 'approved' || !r.reviewedAt) { r.status = 'approved'; r.reviewedAt = ts; }
        saveReport_(r, false);
        log_('اعتماد تقرير', r.schoolName + ' — ' + d);
      } else if (action === 'return') {
        r.status = 'returned';
        r.reviewNote = cleanNote;
        r.reviewedAt = ts;
        saveReport_(r, false);
        log_('إعادة تقرير للتصحيح', r.schoolName + ' — ' + d + ' — ' + cleanNote);
      } else {
        if (r.status !== 'approved') fail_('هذا التقرير غير معتمد حاليًا.');
        r.status = 'pending';
        r.reviewedAt = '';
        saveReport_(r, false);
        log_('إلغاء اعتماد تقرير', r.schoolName + ' — ' + d);
      }
      return r;
    });
    return { ok: true, report: reportOut_(rec, fields_(), retiredKpis_()) };
  });
}

function api_approveAll(token, date) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const d = checkDate_(date);
    const count = withLock_(() => {
      const entries = reportIndex_().list.filter((e) => e.date === d && e.status === 'pending');
      const recs = readRecords_(entries).filter((r) => r.status === 'pending');
      if (!recs.length) return 0;
      const ts = nowTs_();
      recs.forEach((r) => { r.status = 'approved'; r.reviewedAt = ts; });
      saveReportsFixed_(recs);
      log_('اعتماد جماعي', d + ' — ' + recs.length + ' تقرير');
      return recs.length;
    });
    return { ok: true, count: count };
  });
}

/** Everything needed for the printable single-school report. */
function api_report(token, date, schoolId) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const d = checkDate_(date);
    const sid = checkSchoolId_(schoolId);
    const rec = findReport_(d, sid);
    if (!rec) fail_('لا يوجد تقرير لهذه المدرسة في هذا اليوم.');
    const s = schoolById_(sid);
    const c = cfg_();
    const fields = fields_();
    const school = s
      ? { id: s.id, name: s.name, ministryNo: s.ministryNo, stage: s.stage, principal: s.principal, phone: s.phone,
        students: s.students, teachers: s.teachers, staff: s.staff, active: s.active }
      : { id: sid, name: rec.schoolName || 'مدرسة محذوفة', ministryNo: '', stage: '', principal: '', phone: '',
        students: 0, teachers: 0, staff: 0, active: false };
    return { ok: true, school: school, report: reportOut_(rec, fields, retiredKpis_()), supervisor: c.supervisor,
      systemTitle: c.systemTitle, fields: fields };
  });
}

/** Evidence photo for the supervisor (must live in the app's photos folder). */
function api_photo(token, fileId) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const id = typeof fileId === 'string' ? fileId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail_(MSG_.PHOTO_NOT_FOUND);
    if (!photoFolderIds_().length) fail_(MSG_.PHOTO_NOT_FOUND);
    let file;
    try { file = DriveApp.getFileById(id); } catch (e) { fail_(MSG_.PHOTO_NOT_FOUND); }
    if (!inPhotosFolder_(file)) fail_(MSG_.PHOTO_NOT_FOUND);   // current folder or one replaced earlier
    try { if (file.isTrashed()) fail_('هذه الصورة محذوفة (موجودة في سلة المحذوفات في Drive).'); } catch (e) {
      if (e && e.nabdUser) throw e;
    }
    return { ok: true, dataUrl: fileDataUrl_(file) };
  });
}

function api_range(token, from, to) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const f = checkDate_(from);
    const t = checkDate_(to);
    if (f > t) fail_('تاريخ البداية يجب أن يسبق تاريخ النهاية.');
    if (diffDays_(f, t) > LIMITS_.rangeMaxDays) fail_('أقصى مدة للإحصاءات ' + LIMITS_.rangeMaxDays + ' يومًا.');
    const c = cfg_();
    const fields = fields_();
    const retired = retiredKpis_();
    const entries = reportIndex_().list.filter((e) => e.date >= f && e.date <= t);
    const recs = readRecords_(entries).map((r) => ({
      date: r.date, schoolId: r.schoolId, schoolName: r.schoolName, status: r.status, late: r.late,
      derived: deriveReport_(fields, r.answers, retired)
    }));
    const modeField = kpiField_(fields, 'mode');
    return buildRange_({
      from: f, to: t, today: todayStr_(), now: nowHM_(), deadline: c.schedule.deadline,
      workdays: c.schedule.workdays, holidays: holidays_(),
      schools: readSchools_(), recs: recs, modeOptions: modeField ? modeField.options : []
    });
  });
}

/**
 * Deletes a report (photos stay in Drive). The school can send that day again only while it is still
 * open to it: today (unless closed after the deadline) or a missed day inside the late-reporting window.
 */
function api_deleteReport(token, date, schoolId) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const d = checkDate_(date);
    const sid = checkSchoolId_(schoolId);
    withLock_(() => {
      const r = findReport_(d, sid);
      if (!r) fail_(MSG_.REPORT_NOT_FOUND);
      deleteDataRow_(sheet_(SH_REPORTS), r.row);
      MEMO_.rIndex = null;
      log_('حذف تقرير', r.schoolName + ' — ' + d);
    });
    return { ok: true };
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// 11. Supervisor API — schools
// ═══════════════════════════════════════════════════════════════════════════

/** Cleans and validates the editable school fields. */
function validateSchoolInput_(x) {
  const name = cleanText_(x.name);
  if (name.length < 2 || name.length > 120) fail_('اسم المدرسة يجب أن يكون من 2 إلى 120 حرفًا.');
  const ministryNo = normDigits_(cleanText_(x.ministryNo));
  if (ministryNo.length > 20) fail_('الرقم الوزاري أطول من 20 خانة.');
  const stage = cleanText_(x.stage);
  if (stage && STAGES_.indexOf(stage) < 0) fail_('المرحلة غير صحيحة. اختر من القائمة.');
  const principal = cleanText_(x.principal);
  if (principal.length > 60) fail_('اسم المدير/ة أطول من 60 حرفًا.');
  const phone = normalizePhone_(x.phone);
  if (!phone.ok) fail_('رقم الجوال غير صحيح. اكتب الأرقام فقط (مثل 0501234567).');
  const out = { name: name, ministryNo: ministryNo, stage: stage, principal: principal, phone: phone.value };
  [['students', 'عدد الطلاب'], ['teachers', 'عدد المعلمين'], ['staff', 'عدد الإداريين']].forEach((p) => {
    const n = parseIntStrict_(x[p[0]] === undefined ? null : x[p[0]]);
    if (n === null) { out[p[0]] = 0; return; }
    if (!Number.isInteger(n) || n < 0 || n > LIMITS_.countMax) fail_(p[1] + ' يجب أن يكون رقمًا صحيحًا من 0 إلى 100000.');
    out[p[0]] = n;
  });
  return out;
}

function api_schools(token) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const base = baseUrl_();
    return { baseUrl: base, generalLink: generalLink_(base), devMode: devMode_(),
      schools: readSchools_().map((s) => adminSchool_(s, base)) };
  });
}

/** Creates (no id) or updates a school. */
function api_saveSchool(token, school) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    if (!isObj_(school)) fail_('بيانات المدرسة غير صالحة.');
    const v = validateSchoolInput_(school);
    const id = typeof school.id === 'string' ? school.id.trim() : '';
    const saved = withLock_(() => {
      const list = readSchools_();
      const nk = normKey_(v.name);
      if (list.some((s) => s.id !== id && normKey_(s.name) === nk)) fail_('توجد مدرسة بالاسم نفسه. اختر اسمًا مختلفًا.');
      if (id) {
        const s = schoolById_(id);
        if (!s) fail_(MSG_.SCHOOL_NOT_FOUND);
        Object.assign(s, v);
        if (typeof school.active === 'boolean') s.active = school.active;
        updateSchoolRow_(s);
        log_('تعديل مدرسة', s.name);
        return s;
      }
      const s = newSchool_(list, v);
      if (school.active === false) s.active = false;
      appendSchools_([s]);
      log_('إضافة مدرسة', s.name);
      return s;
    });
    return { ok: true, school: adminSchool_(saved, baseUrl_()) };
  });
}

function api_bulkAddSchools(token, text) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    if (typeof text !== 'string' || !cleanText_(text)) fail_('اكتب اسم مدرسة واحدة على الأقل.');
    if (text.length > 100000) fail_('القائمة طويلة جدًا.');
    if (parseBulkSchools_(text, []).count > LIMITS_.bulkMaxLines) {
      fail_('الحد الأقصى ' + LIMITS_.bulkMaxLines + ' مدرسة في المرة الواحدة. قسّم القائمة على دفعات.');
    }
    return withLock_(() => {
      const existing = readSchools_();
      const parsed = parseBulkSchools_(text, existing.map((s) => s.name));
      const fresh = [];
      parsed.items.forEach((it) => {
        fresh.push(newSchool_(existing.concat(fresh), { name: it.name, principal: it.principal, phone: it.phone,
          students: it.students, teachers: it.teachers, staff: it.staff }));
      });
      appendSchools_(fresh);
      if (fresh.length) log_('إضافة مدارس دفعة واحدة', fresh.length + ' مدرسة');
      return { ok: true, added: fresh.length, skipped: parsed.skipped };
    });
  });
}

/** Shared body for the small per-school actions. */
function schoolAction_(token, id, mutate) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const sid = checkSchoolId_(id);
    const s = withLock_(() => {
      const school = schoolById_(sid);
      if (!school) fail_(MSG_.SCHOOL_NOT_FOUND);
      mutate(school);
      return school;
    });
    return { ok: true, school: adminSchool_(s, baseUrl_()) };
  });
}

function api_setSchoolActive(token, id, active) {
  if (typeof active !== 'boolean') {
    return run_(() => { requireAuth_(token); fail_('قيمة غير صالحة.'); });
  }
  return schoolAction_(token, id, (s) => {
    s.active = active;
    updateSchoolRow_(s);
    log_(active ? 'تفعيل مدرسة' : 'إيقاف مدرسة', s.name);
  });
}

function api_regenerateLink(token, id) {
  return schoolAction_(token, id, (s) => {
    const toks = toSet_(readSchools_().map((x) => x.token));
    let t;
    do { t = newSchoolToken_(); } while (toks[t]);
    s.token = t;
    updateSchoolRow_(s);
    log_('تغيير رابط مدرسة', s.name);
  });
}

function api_regeneratePin(token, id) {
  return schoolAction_(token, id, (s) => {
    let pin;
    do { pin = newPin_(); } while (pin === s.pin);
    s.pin = pin;
    updateSchoolRow_(s);
    try { cache_().remove('pin:' + s.id); } catch (e) { /* ignore */ }
    log_('تغيير رمز مدرسة', s.name);
  });
}

/** Removes the school row; its reports stay (with the school name snapshot). */
function api_deleteSchool(token, id) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const sid = checkSchoolId_(id);
    withLock_(() => {
      const s = schoolById_(sid);
      if (!s) fail_(MSG_.SCHOOL_NOT_FOUND);
      deleteDataRow_(sheet_(SH_SCHOOLS), s._row);
      MEMO_.schools = null;
      log_('حذف مدرسة', s.name);
    });
    return { ok: true };
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// 12. Supervisor API — form & settings (+ daily digest trigger)
// ═══════════════════════════════════════════════════════════════════════════

function api_saveFields(token, fields) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const clean = validateFields_(fields);
    if (JSON.stringify(clean).length > 60000) fail_('النموذج كبير جدًا. اختصر الخيارات أو التوضيحات.');
    withLock_(() => {
      saveFields_(clean);
      log_('حفظ النموذج', clean.length + ' سؤال');
    });
    return { ok: true, fields: clean };
  });
}

function api_applyPreset(token, presetKey) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    if (typeof presetKey !== 'string' || !PRESETS_[presetKey]) fail_('النموذج الجاهز غير معروف.');
    const fields = presetFields_(presetKey);
    withLock_(() => {
      saveFields_(fields);
      log_('تطبيق نموذج جاهز', PRESETS_[presetKey].label);
    });
    return { ok: true, fields: fields };
  });
}

function api_getSettings(token) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    const c = cfg_();
    const base = baseUrl_();
    let spreadsheetUrl = null;
    try { spreadsheetUrl = ss_().getUrl(); } catch (e) { spreadsheetUrl = null; }
    return {
      supervisor: c.supervisor,
      systemTitle: c.systemTitle,
      schedule: c.schedule,
      review: c.review,
      links: c.links,
      alerts: c.alerts,
      digest: c.digest,
      holidays: holidays_(),
      messageTemplate: c.messageTemplate,
      returnTemplate: c.returnTemplate,
      baseUrl: base,
      generalLink: generalLink_(base),
      webAppUrl: cleanWebAppUrl_(c.webAppUrl),
      detectedUrl: cleanWebAppUrl_(serviceUrl_()),
      devMode: devMode_(),
      spreadsheetUrl: spreadsheetUrl,
      photosFolderUrl: photosFolderUrl_(),
      storage: driveStorage_(),
      ownerEmail: c.ownerEmail,
      version: APP_VERSION,
      presets: presetList_()
    };
  });
}

/** The web-app URL typed by the supervisor: '' (empty) or a clean '…/exec' URL; anything else fails. */
function webAppUrlInput_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail_('رابط تطبيق الويب غير صالح.');
  const raw = cleanText_(v);
  if (!raw) return '';
  const u = cleanWebAppUrl_(raw);
  if (u) return u;
  if (/\/dev(?:[?#].*)?$/.test(raw)) {
    fail_('هذا رابط النسخة التجريبية (⁦/dev⁩) ولا يعمل لدى المدارس. انسخ «رابط تطبيق الويب» من «نشر» ← ' +
      '«إدارة عمليات النشر» — وهو ينتهي بـ ⁦/exec⁩.');
  }
  fail_('رابط تطبيق الويب غير صحيح. يبدأ بـ https://script.google.com/ وينتهي بـ ⁦/exec⁩ — انسخه من «نشر» ← ' +
    '«إدارة عمليات النشر».');
}

function intInRange_(v, min, max, msg) {
  const n = parseIntStrict_(typeof v === 'number' || typeof v === 'string' ? v : NaN);
  if (!Number.isInteger(n) || n < min || n > max) fail_(msg);
  return n;
}
function boolSetting_(obj, key, msg) {
  if (!isObj_(obj) || typeof obj[key] !== 'boolean') fail_(msg);
  return obj[key];
}

/**
 * Validates a partial settings object against the current config (pure apart
 * from fail_). Returns { patch, holidays|null, labels:[changed group names] }.
 */
function validateSettings_(s, cur) {
  const patch = {};
  const labels = [];
  let holidays = null;
  if ('systemTitle' in s) {
    const t = cleanText_(s.systemTitle);
    if (t.length < 2 || t.length > 60) fail_('اسم النظام يجب أن يكون من 2 إلى 60 حرفًا.');
    patch.systemTitle = t;
    labels.push('اسم النظام');
  }
  if ('supervisor' in s) {
    patch.supervisor = validateSupervisor_(s.supervisor, cur.supervisor, true);
    labels.push('بيانات المشرف');
  }
  if ('schedule' in s) {
    const x = s.schedule;
    if (!isObj_(x)) fail_('مواعيد التسليم غير صالحة.');
    const out = clone_(cur.schedule);
    if ('deadline' in x) {
      const d = normHHMM_(x.deadline);
      if (!d) fail_('آخر موعد للإرسال يجب أن يكون وقتًا صحيحًا مثل 09:00.');
      out.deadline = d;
    }
    if ('workdays' in x) {
      if (!Array.isArray(x.workdays)) fail_('أيام الدوام غير صالحة.');
      const days = [];
      x.workdays.forEach((d) => {
        const n = typeof d === 'number' ? d : parseIntStrict_(String(d));
        if (!Number.isInteger(n) || n < 0 || n > 6) fail_('أيام الدوام غير صالحة.');
        if (days.indexOf(n) < 0) days.push(n);
      });
      if (!days.length) fail_('اختر يوم دوام واحدًا على الأقل.');
      out.workdays = days.sort((a, b) => a - b);
    }
    if ('allowLate' in x) out.allowLate = boolSetting_(x, 'allowLate', 'قيمة «السماح بالإرسال المتأخر» غير صالحة.');
    if ('backfillDays' in x) {
      out.backfillDays = intInRange_(x.backfillDays, 0, 7, 'عدد أيام إرسال التقارير الفائتة يجب أن يكون من 0 إلى 7.');
    }
    patch.schedule = out;
    labels.push('مواعيد التسليم');
  }
  if ('review' in s) {
    patch.review = { enabled: boolSetting_(s.review, 'enabled', 'قيمة «مراجعة المشرف» غير صالحة.') };
    labels.push('المراجعة والاعتماد');
  }
  if ('links' in s) {
    patch.links = { generalEnabled: boolSetting_(s.links, 'generalEnabled', 'قيمة «الرابط العام» غير صالحة.') };
    labels.push('طرق الإرسال');
  }
  if ('webAppUrl' in s) {
    patch.webAppUrl = webAppUrlInput_(s.webAppUrl);
    if (labels.indexOf('طرق الإرسال') < 0) labels.push('رابط تطبيق الويب');
  }
  if ('alerts' in s) {
    const x = s.alerts;
    if (!isObj_(x)) fail_('إعدادات التنبيهات غير صالحة.');
    const out = clone_(cur.alerts);
    if ('studentAbsencePct' in x) {
      out.studentAbsencePct = intInRange_(x.studentAbsencePct, 1, 100, 'حد غياب الطلاب يجب أن يكون من 1 إلى 100.');
    }
    if ('teacherAbsencePct' in x) {
      out.teacherAbsencePct = intInRange_(x.teacherAbsencePct, 1, 100, 'حد غياب المعلمين يجب أن يكون من 1 إلى 100.');
    }
    if ('activationPct' in x) {
      out.activationPct = intInRange_(x.activationPct, 1, 100, 'الحد الأدنى لتفعيل الحصص يجب أن يكون من 1 إلى 100.');
    }
    if ('jumpPct' in x) {
      out.jumpPct = intInRange_(x.jumpPct, 10, 500, 'نسبة الارتفاع المفاجئ يجب أن تكون من 10 إلى 500.');
    }
    patch.alerts = out;
    labels.push('التنبيهات الذكية');
  }
  if ('digest' in s) {
    const x = s.digest;
    if (!isObj_(x)) fail_('إعدادات الملخص اليومي غير صالحة.');
    const out = clone_(cur.digest);
    if ('enabled' in x) out.enabled = boolSetting_(x, 'enabled', 'قيمة «الملخص اليومي» غير صالحة.');
    if ('time' in x) {
      const t = normHHMM_(x.time);
      if (!t) fail_('وقت الملخص اليومي يجب أن يكون وقتًا صحيحًا مثل 10:00.');
      out.time = t;
    }
    patch.digest = out;
    labels.push('الملخص اليومي');
  }
  if ('holidays' in s) {
    if (!Array.isArray(s.holidays)) fail_('قائمة الإجازات غير صالحة.');
    const set = {};
    s.holidays.forEach((d) => {
      const v = typeof d === 'string' ? d.trim() : '';
      if (!isIsoDate_(v)) fail_('يوجد تاريخ إجازة غير صحيح: ' + cleanText_(String(d)).slice(0, 20));
      set[v] = true;
    });
    holidays = Object.keys(set).sort();
    if (holidays.length > LIMITS_.holidaysMax) fail_('الحد الأقصى ' + LIMITS_.holidaysMax + ' يوم إجازة.');
    labels.push('الإجازات');
  }
  [['messageTemplate', DEFAULT_MESSAGE_TEMPLATE, 'رسالة إرسال الرابط'],
    ['returnTemplate', DEFAULT_RETURN_TEMPLATE, 'رسالة الإعادة للتصحيح']].forEach((t) => {
    if (!(t[0] in s)) return;
    if (typeof s[t[0]] !== 'string') fail_('نص «' + t[2] + '» غير صالح.');
    const v = cleanText_(s[t[0]], true);
    if (v.length > 600) fail_('نص «' + t[2] + '» أطول من 600 حرف.');
    patch[t[0]] = v || t[1];
    labels.push(t[2]);
  });
  return { patch: patch, holidays: holidays, labels: labels };
}

function api_saveSettings(token, s) {
  return run_(() => {
    requireAuth_(token);
    requireSetup_();
    if (!isObj_(s)) fail_('بيانات الإعدادات غير صالحة.');
    withLock_(() => {
      const cur = cfg_();
      const v = validateSettings_(s, cur);
      // Trigger first: if Google refuses it, nothing is saved and the switch stays as it was.
      if (v.patch.digest) {
        const next = v.patch.digest;
        if (JSON.stringify(next) !== JSON.stringify(cur.digest) || (next.enabled && !digestTriggerExists_())) {
          syncDigestTrigger_(next);
        }
      }
      if (Object.keys(v.patch).length) saveCfg_(v.patch);
      if ('webAppUrl' in v.patch) MEMO_.baseUrl = undefined;
      if (v.holidays) { setBigProp_('holidays', JSON.stringify(v.holidays)); MEMO_.holidays = v.holidays; }
      if (v.labels.length) log_('حفظ الإعدادات', v.labels.join('، '));
    });
    return { ok: true };
  });
}

function digestTriggerExists_() {
  try {
    return ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'dailyDigest');
  } catch (e) { return false; }
}

/** Deletes existing dailyDigest triggers and, when enabled, creates one at the chosen time. */
function syncDigestTrigger_(digest) {
  try {
    ScriptApp.getProjectTriggers().forEach((t) => {
      if (t.getHandlerFunction() === 'dailyDigest') ScriptApp.deleteTrigger(t);
    });
    if (digest.enabled) {
      const parts = String(digest.time || '10:00').split(':');
      ScriptApp.newTrigger('dailyDigest').timeBased().everyDays(1)
        .atHour(Number(parts[0])).nearMinute(Number(parts[1])).inTimezone(TZ).create();
    }
  } catch (e) {
    try { console.error('trigger failed: ' + e); } catch (ignore) { /* no console */ }
    fail_('تعذّر ضبط موعد الملخص اليومي. افتح ملف Apps Script مرة واحدة ووافق على الأذونات ثم حاول مجددًا.');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 13. Emails (RTL, inline styles, escaped text) & the dailyDigest trigger
// ═══════════════════════════════════════════════════════════════════════════

/** Shared responsive email frame (tables + inline styles render well in Gmail on phones). */
function emailShell_(heading, sub, bodyHtml) {
  const font = "Tahoma,'Segoe UI',Arial,sans-serif";
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#F5F7F8;" dir="rtl">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="background:#F5F7F8;" dir="rtl"><tr><td align="center" style="padding:20px 12px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" ' +
    'style="max-width:560px;background:#FFFFFF;border:1px solid #E2E8EA;border-radius:16px;' +
    'border-collapse:separate;overflow:hidden;font-family:' + font + ';">' +
    '<tr><td dir="rtl" style="background:#0E7C66;background-image:linear-gradient(135deg,#084F42 0%,#0E7C66 60%,' +
    '#1F7A8C 100%);padding:22px 24px;text-align:right;color:#FFFFFF;">' +
    '<div style="font-size:13px;line-height:1.6;color:#CCE7DF;">' + escHtml_(APP_NAME) + '</div>' +
    '<div style="font-size:20px;line-height:1.5;font-weight:bold;color:#FFFFFF;margin-top:2px;">' + escHtml_(heading) + '</div>' +
    (sub ? '<div style="font-size:14px;line-height:1.6;color:#E6F3EF;margin-top:2px;">' + escHtml_(sub) + '</div>' : '') +
    '</td></tr>' +
    '<tr><td dir="rtl" style="padding:22px 24px;text-align:right;color:#10222B;font-size:15px;line-height:1.8;">' +
    bodyHtml + '</td></tr>' +
    '<tr><td dir="rtl" style="padding:14px 24px;background:#F0F3F4;text-align:right;color:#6B7C86;font-size:12px;' +
    'line-height:1.7;">' + escHtml_(APP_NAME) + ' • نسخة مستقلة خاصة بك — ' + escHtml_(PRIVACY_NOTE_) + '.</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function otpEmailHtml_(code, c) {
  const body =
    '<p style="margin:0 0 10px;">مرحبًا،</p>' +
    '<p style="margin:0 0 6px;">استخدم الرمز التالي للدخول إلى لوحة «' + escHtml_(c.systemTitle) + '»:</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td align="center" style="padding:16px 0 18px;">' +
    '<div dir="ltr" style="display:inline-block;font-family:\'Courier New\',Consolas,monospace;font-size:34px;' +
    'line-height:1.2;letter-spacing:10px;font-weight:bold;color:#084F42;background:#E6F3EF;border:1px solid #CCE7DF;' +
    'border-radius:12px;padding:14px 18px 14px 28px;">' + escHtml_(code) + '</div></td></tr></table>' +
    '<p style="margin:0 0 6px;color:#3E5360;">الرمز صالح لمدة 10 دقائق، ويُستخدم مرة واحدة فقط.</p>' +
    '<p style="margin:0;color:#6B7C86;font-size:13px;">إذا لم تطلب الرمز تجاهل الرسالة — ' +
    'لا يستطيع أحد الدخول إلى لوحتك دون هذا الرمز.</p>';
  return emailShell_('رمز الدخول إلى لوحة المشرف', '', body);
}

function otpEmailText_(code, c) {
  return 'رمز الدخول إلى ' + APP_NAME + ' (' + c.systemTitle + '): ' + code + '\n' +
    'صالح لمدة 10 دقائق.\nإذا لم تطلب الرمز تجاهل الرسالة.';
}

function digestHtml_(day, c, link) {
  const t = day.totals;
  const pendingAll = t.pending + (day.pendingOther || []).length;
  const kpi = (label, value, color) =>
    '<td width="50%" valign="top" style="padding:6px;">' +
    '<div style="background:#F0F3F4;border-radius:12px;padding:12px 14px;text-align:right;">' +
    '<div style="font-size:12px;color:#6B7C86;line-height:1.5;">' + escHtml_(label) + '</div>' +
    '<div dir="rtl" style="font-size:22px;font-weight:bold;color:' + color + ';line-height:1.4;">' + escHtml_(value) +
    '</div></div></td>';
  const absColor = t.students.absencePct !== null && t.students.absencePct >= c.alerts.studentAbsencePct
    ? '#C0392B' : '#10222B';
  const actColor = t.lessons.activationPct !== null && t.lessons.activationPct < c.alerts.activationPct
    ? '#B26A00' : '#10222B';
  let body =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 -6px;">' +
    '<tr>' + kpi('التسليم', t.submitted + ' من ' + t.schools, '#0E7C66') +
    kpi('بانتظار المراجعة', String(pendingAll), pendingAll ? '#B26A00' : '#10222B') + '</tr>' +
    '<tr>' + kpi('غياب الطلاب', fmtPct_(t.students.absencePct), absColor) +
    kpi('تفعيل الحصص', fmtPct_(t.lessons.activationPct), actColor) + '</tr></table>';

  const missing = day.rows.filter((r) => r.flags.indexOf('missing') >= 0).map((r) => r.school.name);
  // The trigger fires within ±15 min of the chosen time: say so when it ran before the deadline.
  const early = day.isToday && day.isWorkday && day.now <= day.deadline;
  body += '<h3 style="margin:18px 0 6px;font-size:16px;color:#084F42;">لم تُرسل بعد (' + missing.length + ')' +
    (early && missing.length ? '<span style="font-size:13px;font-weight:normal;color:#6B7C86;"> — الموعد النهائي ' +
      escHtml_(fmtTime12_(day.deadline)) + ' لم يحن بعد</span>' : '') + '</h3>';
  body += missing.length
    ? '<ul style="margin:0;padding:0 18px 0 0;color:#3E5360;">' +
      missing.slice(0, 40).map((n) => '<li style="margin:2px 0;">' + escHtml_(n) + '</li>').join('') +
      (missing.length > 40 ? '<li style="margin:2px 0;">و' + (missing.length - 40) + ' مدارس أخرى</li>' : '') + '</ul>'
    : '<p style="margin:0;color:#1E8A4C;">أرسلت جميع المدارس تقاريرها ✓</p>';

  const alerts = day.alerts.filter((a) => a.level !== 'info').slice(0, 12);
  if (alerts.length) {
    body += '<h3 style="margin:18px 0 6px;font-size:16px;color:#084F42;">تنبيهات</h3>';
    body += alerts.map((a) => {
      const col = a.level === 'danger' ? ['#FCEBE8', '#C0392B'] : ['#FDF1DD', '#B26A00'];
      return '<div style="background:' + col[0] + ';border-right:4px solid ' + col[1] + ';border-radius:8px;' +
        'padding:8px 12px;margin:6px 0;color:#10222B;font-size:14px;">' + escHtml_(a.text) + '</div>';
    }).join('');
  }

  const att = [['الطلاب', t.students], ['المعلمون', t.teachers], ['الإداريون', t.staff]].filter((x) => x[1].total > 0);
  if (att.length) {
    body += '<h3 style="margin:18px 0 6px;font-size:16px;color:#084F42;">الحضور والغياب</h3>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="border-collapse:collapse;font-size:14px;">' +
      '<tr style="background:#F0F3F4;color:#3E5360;"><td style="padding:6px 8px;">الفئة</td>' +
      '<td style="padding:6px 8px;">الحاضرون</td><td style="padding:6px 8px;">الغائبون</td>' +
      '<td style="padding:6px 8px;">نسبة الغياب</td></tr>' +
      att.map((x) => '<tr style="border-bottom:1px solid #E2E8EA;"><td style="padding:6px 8px;">' + x[0] + '</td>' +
        '<td style="padding:6px 8px;">' + x[1].present + '</td><td style="padding:6px 8px;">' + x[1].absent + '</td>' +
        '<td style="padding:6px 8px;">' + fmtPct_(x[1].absencePct) + '</td></tr>').join('') + '</table>';
  }

  if (link) {
    body += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;"><tr>' +
      '<td style="background:#0E7C66;border-radius:10px;">' +
      '<a href="' + escHtml_(link) + '" target="_blank" style="display:inline-block;padding:12px 22px;color:#FFFFFF;' +
      'font-size:15px;font-weight:bold;text-decoration:none;font-family:Tahoma,Arial,sans-serif;">فتح لوحة المتابعة</a>' +
      '</td></tr></table>';
  }
  return emailShell_('ملخص اليوم — ' + c.systemTitle, dateLabelAr_(day.date), body);
}

function digestText_(day) {
  const t = day.totals;
  const missing = day.rows.filter((r) => r.flags.indexOf('missing') >= 0).map((r) => '- ' + r.school.name);
  const early = day.isToday && day.isWorkday && day.now <= day.deadline;
  return 'ملخص ' + dateLabelAr_(day.date) + '\n' +
    'التسليم: ' + t.submitted + ' من ' + t.schools + '\n' +
    'بانتظار المراجعة: ' + (t.pending + (day.pendingOther || []).length) + '\n' +
    'غياب الطلاب: ' + fmtPct_(t.students.absencePct) + '\n' +
    (missing.length ? 'لم تُرسل بعد' + (early ? ' (قبل الموعد النهائي ' + fmtTime12_(day.deadline) + ')' : '') + ':\n' +
      missing.join('\n') : 'أرسلت جميع المدارس تقاريرها.');
}

/**
 * Time-driven trigger: emails the owner a summary of today (workdays only).
 * Only a genuine run of this project's own trigger may send: google.script.run can reach this
 * global from any page, and an early anonymous call would otherwise claim (and suppress) the day.
 */
function dailyDigest(e) {
  try {
    const uid = e && e.triggerUid ? String(e.triggerUid) : '';
    if (!uid || !ScriptApp.getProjectTriggers().some((t) => String(t.getUniqueId()) === uid)) return;
    bootstrap_({ menu: true });
    const c = cfg_();
    if (!c.setupDone || !c.digest.enabled || !c.ownerEmail) return;
    const today = todayStr_();
    if (!isWorkday_(today, c.schedule.workdays, toSet_(holidays_()))) return;
    // At most one digest per day (guards against duplicate trigger runs).
    const claimed = withLock_(() => {
      if (props_().getProperty('digestSent') === today) return false;
      props_().setProperty('digestSent', today);
      return true;
    });
    if (!claimed) return;
    const day = dayData_(today);
    const t = day.totals;
    try {
      MailApp.sendEmail({
        to: c.ownerEmail,
        subject: 'ملخص اليوم: التسليم ' + t.submitted + ' من ' + t.schools + ' — ' + c.systemTitle,
        htmlBody: digestHtml_(day, c, baseUrlStored_()),
        body: digestText_(day),
        name: APP_NAME
      });
    } catch (e) {
      withLock_(() => props_().deleteProperty('digestSent'));
      throw e;
    }
  } catch (e) {
    try { console.error((e && e.stack) || String(e)); } catch (ignore) { /* no console */ }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 14. Spreadsheet menu (SpreadsheetApp.getUi() only here)
// ═══════════════════════════════════════════════════════════════════════════

function onOpen(e) {
  try {
    SpreadsheetApp.getUi().createMenu('📋 نبض المدارس')
      .addItem('🔗 رابط لوحة التحكم', 'menuShowLink')
      .addItem('📖 خطوات التشغيل', 'menuShowGuide')
      .addSeparator()
      .addItem('🧹 تصفير النظام…', 'menuReset')
      .addToUi();
  } catch (err) { /* simple trigger without UI */ }
  try { ensureStartSheet_(); } catch (err) { /* simple trigger may lack authorisation */ }
}

/** Minimal styled document for spreadsheet dialogs. */
function dialogHtml_(inner) {
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:4px 6px 12px;font-family:Tahoma,"Segoe UI",Arial,sans-serif;color:#10222B;' +
    'font-size:14px;line-height:1.8;direction:rtl}' +
    'h2{font-size:17px;margin:0 0 8px;color:#084F42}p{margin:0 0 10px}' +
    '.url{display:flex;gap:8px;margin:6px 0 12px}' +
    '.url input{flex:1;min-width:0;direction:ltr;text-align:left;font:13px Consolas,monospace;padding:10px;' +
    'border:1px solid #CBD5D8;border-radius:10px;background:#F0F3F4;color:#10222B}' +
    '.btn{display:inline-block;border:0;border-radius:10px;padding:10px 16px;font:600 14px Tahoma,Arial,sans-serif;' +
    'cursor:pointer;text-decoration:none;background:#0E7C66;color:#fff}.btn.s{background:#E6F3EF;color:#084F42}' +
    'ol{margin:0 0 12px;padding:0 20px 0 0}li{margin:0 0 8px}' +
    '.note{background:#FBF3E2;border-radius:10px;padding:10px 12px;color:#5C4510;font-size:13px}' +
    '.muted{color:#6B7C86;font-size:12px}</style></head><body>' + inner + '</body></html>';
}

function guideListHtml_() {
  return '<ol>' + DEPLOY_STEPS_.map((s) => '<li>' + escHtml_(s) + '</li>').join('') + '</ol>' +
    '<p class="muted">' + escHtml_(DEPLOY_UPDATE_NOTE_) + '</p>' +
    '<p class="note">🔒 ' + escHtml_(PRIVACY_NOTE_) + '.</p>';
}

/** Asks Google for any permission the owner skipped (granular consent) before a menu action runs. */
function requireAllScopes_() {
  if (typeof ScriptApp.requireAllScopes === 'function') ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
}

function menuShowLink() {
  requireAllScopes_();
  try { bootstrap_({ menu: true }); } catch (e) { /* show the dialog anyway */ }
  const ui = SpreadsheetApp.getUi();
  let url = null;
  try { url = baseUrlStored_(); } catch (e) { url = null; }   // never getUrl() here: it cannot know the deployment
  let html, title, h;
  if (url) {
    title = 'رابط لوحة التحكم';
    h = 300;
    html = dialogHtml_(
      '<p>افتح هذا الرابط لإدارة المدارس ومتابعة التقارير. احفظه في المفضلة على جوالك وحاسوبك.</p>' +
      '<div class="url"><input id="u" readonly value="' + escHtml_(url) + '" onclick="this.select()">' +
      '<button class="btn s" onclick="var i=document.getElementById(\'u\');i.select();' +
      'try{document.execCommand(\'copy\');this.textContent=\'تم النسخ ✓\';}catch(e){}">نسخ</button></div>' +
      '<p><a class="btn" href="' + escHtml_(url) + '" target="_blank" rel="noopener">فتح لوحة التحكم</a></p>' +
      '<p class="muted">روابط المدارس تجدها داخل اللوحة في قسم «المدارس». لا ترسل هذا الرابط للمدارس.</p>');
  } else {
    title = 'رابط لوحة التحكم غير محفوظ بعد';
    h = 560;
    html = dialogHtml_('<p>لم يُحفظ رابط لوحة التحكم بعد. إن كنت نشرت البرنامج فافتح «رابط تطبيق الويب» ' +
      '(المنتهي بـ ⁦/exec⁩) مرة واحدة ليُحفظ تلقائيًا. وإن لم تنشره بعد فانشره مرة واحدة بهذه الخطوات:</p>' +
      guideListHtml_());
  }
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(h), title);
}

function menuShowGuide() {
  requireAllScopes_();
  const ui = SpreadsheetApp.getUi();
  const html = dialogHtml_('<h2>خطوات التشغيل (مرة واحدة فقط)</h2>' + guideListHtml_());
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(600).setHeight(560), '📖 خطوات التشغيل');
}

/** Wipes settings, sessions, schools, reports and the log after typing «تصفير». Photos stay in Drive. */
function menuReset() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('🧹 تصفير النظام',
    'سيُحذف كل شيء: المدارس والتقارير والسجل والإعدادات وجلسات الدخول، ويعود النظام إلى معالج التجهيز.\n' +
    '(صور الشواهد تبقى في مجلدها في Google Drive.)\n\nللتأكيد اكتب كلمة: تصفير',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  if (cleanText_(res.getResponseText()) !== 'تصفير') {
    ui.alert('لم يتم التصفير', 'الكلمة المكتوبة غير مطابقة، ولم يتغيّر شيء.', ui.ButtonSet.OK);
    return;
  }
  bootstrap_({ menu: true });
  withLock_(() => {
    try { ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t)); } catch (e) { /* ignore */ }
    const ss = ss_();
    [SH_SCHOOLS, SH_REPORTS, SH_LOG].forEach((name) => {
      const sh = ss.getSheetByName(name);
      if (!sh) return;
      const lastRow = sh.getLastRow();
      const lastCol = Math.max(sh.getLastColumn(), 1);
      if (lastRow >= 2) sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
      if (name === SH_REPORTS && lastCol > REPORT_FIXED_COLS_) {
        sh.getRange(1, REPORT_FIXED_COLS_ + 1, 1, lastCol - REPORT_FIXED_COLS_).clearContent();
      }
    });
    props_().deleteAllProperties();
    try { cache_().removeAll(['otp', 'otp_last', 'otp_hour', 'otp_6h']); } catch (e) { /* ignore */ }
  });
  bootstrap_({ menu: true });
  log_('تصفير النظام', '');
  try { ss_().toast('تم تصفير النظام. افتح رابط لوحة التحكم لبدء التجهيز من جديد.', APP_NAME, 8); } catch (e) { /* ignore */ }
}
