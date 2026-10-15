# نبض المدارس (Nabd): architecture

This document is for developers who maintain the code. The user guides are in Arabic:
[دليل التثبيت](دليل-التثبيت.md) (installation) and [دليل الاستخدام](دليل-الاستخدام.md) (daily use).

The code in `src/` is the reference. Function names are cited so you can grep for them.

---

## 1. What it is and how it is deployed

Nabd is a Google Apps Script web app with an Arabic RTL interface. An educational supervisor
(المشرف التربوي) uses it to follow the daily reports of the schools he oversees. Each school principal
fills a short daily form from a phone. The supervisor reviews each report (approve, or return it for
correction with a note), sees totals and alerts, prints reports and looks at statistics over time.

**There is no central server and no central database.**

```
 author ("Ahmad")                       each supervisor (own Google account)
 ───────────────                        ─────────────────────────────────────────────
 Google Sheet template  ──/copy──►  copy of the Sheet + bound Apps Script project
 (bound script pasted,                     │  deployed once as a web app:
  never deployed)                          │  Execute as: Me · Who has access: Anyone
                                           ▼
                           https://script.google.com/macros/s/<id>/exec
                              │                 │                  │
                    ?s=<token>          ?f=all (+4-digit code)     (no params)
                    principal form      general link / picker      supervisor SPA
                                           │
                     data: the copied spreadsheet (sheets) + Script Properties/Cache
                           + a Drive folder «نبض المدارس — شواهد المتابعة» (photos)
```

* The author shares a template spreadsheet that has the script bound to it. Supervisors open the
  template's `/copy` link. Each copy is fully independent: it has its own spreadsheet, script, deployment
  and data. The template can be deleted later without affecting anyone.
* The web app runs as the supervisor ("Execute as: Me"). Principals never sign in to Google, because
  access is set to "Anyone" (`ANYONE_ANONYMOUS`). All data is read and written with the supervisor's
  permissions, inside the supervisor's account.
* The supervisor logs in with a one-time code sent by email to the owner address of the copy, which is
  `Session.getEffectiveUser()`.

## 2. Repository layout

```
src/                     Apps Script sources (the reference implementation)
  Code.gs                all server code (single file, ~4300 lines, 14 numbered sections)
  Admin.html             supervisor SPA: setup wizard, login, Today / Schools / Stats / Form / Settings
  School.html            principal page: form, receipt, correction, late reports, school picker
  Styles.html            design system (one <style>: tokens + components), included by both pages
  Common.html            shared client helpers (global `App`), included by both pages
  appsscript.json        manifest (time zone, V8, explicit OAuth scopes, web-app defaults)
tools/build-bundle.js    builds the single-file bundle (see §13); `--check` verifies dist/ is up to date
tools/build-demo.js      builds the browser demo (`npm run build:demo`)
dist/Code.gs             bundle: Code.gs + every .html embedded → the ONE file supervisors paste
dist/appsscript.json     optional manifest to paste next to it (a copy of src/appsscript.json)
dist/demo.html           self-contained browser demo: the real Code.gs + pages on the mock, with sample data
test/gas-mock.js         high-fidelity Apps Script mock (isomorphic: Node + browser)
test/runtime.js          loads Code.gs into the mock with google.script.run semantics
test/server.js           local dev server (pages + RPC shim + test endpoints)
test/unit.js             node:test suite of server behaviour (through the runtime)
test/bundle.js           builds dist/, loads dist/Code.gs ALONE (no .html files) and checks it behaves like src/
test/e2e.js              Playwright end-to-end scenarios; also rewrites the curated docs/screenshots set
docs/screenshots/        the README's screenshots, produced by the e2e run (mobile 390×844 @2x, desktop 1366×900)
```

`Code.gs` sections, in file order:
1. constants and defaults
2. pure helpers (strings, cells, ids, dates)
3. domain logic (pure: fields, validation, derived metrics, edit rules, bulk parsing, day dashboard, range statistics)
4. platform glue (errors, lock, properties, cache, config)
5. storage (sheets, «ابدأ هنا», schools, reports, mirror columns, log)
6. photos
7. bootstrap and routing
8. school API
9. auth and setup API
10. dashboard, review and statistics API
11. schools API
12. form and settings API
13. emails and the `dailyDigest` trigger
14. spreadsheet menu

Domain logic in §3 takes plain data and touches no Google service. That is why most rules can be unit-tested directly.

## 3. Request routing and page boot

`doGet(e)` calls `bootstrap_()`, then picks a page:

| URL | Page | `window.BOOT` |
|---|---|---|
| `?s=<token>` (optional `&d=yyyy-MM-dd`) | `School.html`, mode `form` | `{page:'school', mode:'form', appName, version, systemTitle, token, form: schoolFormData_(token, d)}`. If day `d` is not open (`NOT_EDITABLE`), the page silently falls back to today. |
| `?s=__preview` | `School.html`, preview | form with a sample school and `preview:true`. Uploads and submissions are rejected. |
| `?f=all` | `School.html`, mode `picker` | `{…, picker: pickerData_()}` → `{ok, supervisor, schools:[{id,name}]}` or `{ok:false, code:'NOT_SETUP'|'DISABLED'|'ERROR', error}` |
| anything else | `Admin.html` | `{page:'admin', …, status: publicStatus_()}` → `{setupDone, ownerEmailMasked, supervisorName, deployed, devMode}` |

* `renderPage_()` evaluates the template with `bootJson = safeJson_(boot)`. `safeJson_` escapes `<`,
  U+2028 and U+2029. It also sets the title and the viewport meta tag, and uses `XFrameOptionsMode.ALLOWALL`.
* HTML is loaded through one helper (`htmlTemplate_` / `htmlFile_`). When the global
  `NABD_EMBEDDED_FILES_` exists (in the bundle), the page source comes from it; otherwise from the project's `.html` files.
  `include(name)` (used by `<?!= include('Styles') ?>`) accepts only `^[A-Za-z][A-Za-z0-9_]{0,40}$`.
* If doGet fails unexpectedly, it renders a minimal Arabic error page. A permission problem gets a
  specific message that names the menu path that fixes it (`permMessage_`).
* `captureWebAppUrl_()` saves the deployment URL (`cfg.webAppUrl`) the first time the supervisor page is
  opened from a real `/exec` URL (see §8, "web-app URL").

## 4. Server execution model

Every exposed function has this shape:

```js
function api_x(token, …) {
  return run_(() => {            // bootstrap_() + error mapping
    requireAuth_(token);         // supervisor functions only → 'AUTH_REQUIRED'
    requireSetup_();             // → 'NOT_SETUP'
    …validate every argument…
    return withLock_(() => { …read-modify-write… });
  }, { school: true });          // principal-facing: sheet-layout errors become «النظام غير متاح مؤقتًا»
}
```

* **Public vs private.** `google.script.run` can call any global function whose name does not end in `_`.
  The only public functions are `doGet`, `include`, `onOpen`, `menuShowLink`, `menuShowGuide`,
  `menuReset`, `dailyDigest` and the `api_*` functions. Everything else ends in `_`.
* **`run_`.** User errors are created by `fail_()` (`e.nabdUser`) and reach the client unchanged.
  Permission errors become the Arabic fix-it message. Any other error is logged with `console.error`
  and replaced by «حدث خطأ غير متوقع…». Stack traces never reach the browser.
* **`bootstrap_`** runs at every entry. In order, it:
  1. resets the per-execution memo `MEMO_`;
  2. detects copies (§7);
  3. stores `ssId`, the owner email (web-app and trigger contexts only, never menus) and `version`;
  4. calls `ensureSheets_()`, which creates or repairs the data sheets and is idempotent.
* **`withLock_`** takes `LockService.getScriptLock().waitLock(30000)`. It is re-entrant within one execution.
  Inside the lock it drops memoised data and flushes Sheets before releasing. If the wait times out, the user sees «النظام مشغول…».
* **Memoisation.** `MEMO_` caches `cfg`, `fields`, `schools`, the report index and similar values for
  one execution only. Apps Script starts every execution with fresh globals, and the mock does the same.

## 5. Data model

### 5.1 Spreadsheet (the copy's bound spreadsheet)

All data sheets are RTL with a frozen header row in brand colour. Text columns use number format `'@'`, so Sheets does not
auto-convert dates, times, phones, or values like `TRUE` and `0123`.

**`المدارس`** has one row per school. The 13 fixed columns, in this exact order (this order is a contract):

| # | key | header | notes |
|---|---|---|---|
| A | id | المعرّف | `'S' + 7 [a-z0-9]` |
| B | name | اسم المدرسة | unique (case/space-insensitive), 2–120 chars |
| C | ministryNo | الرقم الوزاري | ≤ 20 |
| D | stage | المرحلة | ابتدائي/متوسط/ثانوي/رياض أطفال/مجمع/أخرى/'' |
| E | principal | المدير/ة | ≤ 60 |
| F | phone | الجوال | digits only, ≤ 15 (`+`/`00` prefixes become plain digits) |
| G–I | students/teachers/staff | عدد الطلاب/المعلمين/الإداريين | optional reference counts (format `'0'`) |
| J | token | رمز الرابط | 20 chars `[A-Za-z0-9]`, starts with a letter (private link) |
| K | pin | رمز المدرسة | 4 digits (general link only) |
| L | active | نشطة | `نعم`/`لا`; only an explicit negative (`لا`, `false`, `0`, `no`, `غير نشطة`, `موقوفة`) means inactive |
| M | createdAt | تاريخ الإضافة | `yyyy-MM-dd HH:mm:ss`; added after the deadline → first due the next day |

Rows typed by hand (no id, token or pin, or a duplicated one) are completed by `repairSchools_()`.
Before repairing, it re-checks the header layout, and it logs what it fixed.

**`التقارير`** has one row per (date, school): 13 fixed columns followed by readable mirror columns.

`key | date | schoolId | schoolName | status | submittedAt | updatedAt | filledBy | late | edits | reviewNote | reviewedAt | answersJson`
(headers: `المفتاح | التاريخ | معرّف المدرسة | المدرسة | الحالة | وقت الإرسال | آخر تعديل | اسم المعبّئ | متأخر | مرات التعديل | ملاحظة المراجعة | وقت المراجعة | البيانات`)

* `key = date + '|' + schoolId`. `status` is stored as an Arabic label: `بانتظار المراجعة` / `معتمد` /
  `معاد للتصحيح`. The API uses `pending` / `approved` / `returned`.
* **`answersJson` (column M) is the source of truth**, capped at 45 000 characters (a cell holds 50 000).
  The columns after M mirror the answers so they can be read in the sheet: one column per simple field,
  one per attendance row × present/absent (e.g. `الطلاب - الحاضرون`), and one with the Drive URLs of the photos.
  The Script Property `fieldCols` maps each column key to its column. A new field appends a column. A renamed field updates the header.
  A removed field keeps its column, and a deleted-then-re-added question reuses its old column.
  The map is verified against the header text, so a column moved by hand is found again. Writing the
  mirror never fails a submission.
* Reads are cheap. `reportIndex_()` reads columns A–E of all rows once per execution. `readRecords_()` then reads
  only the needed rows, grouping nearby rows into one range read.

**`السجل`** is the activity log (`الوقت | العملية | التفاصيل`): setup, logins, school changes, settings,
reviews, deletes, resets. Submissions are not logged. It is trimmed to the newest 2000 rows once it passes 2200.

**`ابدأ هنا`** is a friendly instruction sheet, inserted as the first tab by `ensureStartSheet_()` (from `onOpen` and
setup). It holds the deployment steps `DEPLOY_STEPS_`, the update note and the privacy note.

**Layout guard.** `«المدارس»` and `«التقارير»` are read by column position. So `checkLayout_()` checks that the
13 fixed headers in row 1 are exactly as expected, once per execution, before any read or write. On a mismatch
nothing is written:
* the supervisor gets an Arabic message naming the column and its expected header (`layoutMessage_`);
* principals get «النظام غير متاح مؤقتًا».

If a data sheet was renamed by hand, it is found again by its saved sheet id (`cfg.sheetIds`) and renamed back.

### 5.2 Script Properties

| key | content |
|---|---|
| `cfg` | `{ ssId, ownerEmail, setupDone, setupAt, systemTitle, webAppUrl, photosFolderId, photosFolderIdsOld[], sheetIds{}, supervisor{name,title,office,phone}, schedule{deadline,workdays[0..6],allowLate,backfillDays 0–7}, review{enabled}, links{generalEnabled}, alerts{studentAbsencePct,teacherAbsencePct,activationPct,jumpPct}, digest{enabled,time}, messageTemplate, returnTemplate, version }`. `cfg_()` deep-merges it over `DEFAULT_CFG_`. |
| `fields` | the form definition (array, ≤ 25 fields; see §6.1) |
| `holidays` | sorted, de-duplicated `yyyy-MM-dd` strings (≤ 200) |
| `fieldCols` | `{columnKey: colIndex}` for the mirror columns |
| `retiredKpis` | `{kpi: [old field ids]}`, so old reports keep their KPIs after a KPI question is deleted or re-created |
| `sess:<sha256(token)>` | `{exp, created, last, ua}` (one per session, max 15) |
| `digestSent` | date of the last digest (at most one per day) |
| `counts` | `{d: date, n: {key: count}}` — today's durable counters, reset when the Riyadh date changes: `up:<schoolId>` uploads (max 40), `upb` uploaded bytes over all schools (max 300 MB), `sub:<schoolId>` submissions (max 30), `pin` wrong school codes over all schools (max 60). A cache entry lives 6 h at most, so it cannot hold a daily cap. |
| `secret` | per-install key of the general-link credential (§9.1); a reset or a copied project gets a new one |
| `photoSweep` | the last upload date the orphan sweep finished (§5.4) |
| `photoKeep` | `{photoId: date}` photos of reports the supervisor deleted (never swept; entries kept 14 days) |

Values larger than 8 KB are split into `key#1…key#n`, with `key = '@@chunks:n'` (`setBigProp_` / `getBigProp_`). The
platform limits are 9 KB per value and 500 KB in total.

### 5.3 CacheService (script cache)

| key | purpose | TTL |
|---|---|---|
| `otp:<sha256(cid)>` | one emailed code: `{h: sha256(code + ':' + ssId), exp, tries}` — one record per request (challenge id `cid`) | 10 min |
| `otp_last` | 60-second cooldown between codes | 60 s |
| `otp_hour`, `otp_6h` | fixed-window counters (max 6 per hour, 10 per 6 h) | window |
| `login:<sha256(ticket)>` | one-time sign-in link from the spreadsheet menu (§9.1) | 10 min |
| `pin:<schoolId>` | wrong school-code attempts for one school (max 5) | 15 min |
| `pin:all` | wrong school-code attempts over all schools (max 20); the daily cap is `counts.pin` | 15 min |
| `storage` | `{used, limit}` of the owner's Drive (dashboard warning at 85 %, uploads stop at 90 %) | 6 h |

### 5.4 Drive

* The app creates one folder, `نبض المدارس — شواهد المتابعة`, on the first upload (`cfg.photosFolderId`).
  If it was trashed, a new folder is created and the old id is kept in `photosFolderIdsOld`, so photos in a restored folder still open.
* Files are named `<yyyy-MM-dd>_<schoolId>_<6 random>.<jpg|png|webp>`, with description `<school> — <date>`.
* The app never lists or searches the user's Drive. Every file id that comes from a client is checked
  (`inPhotosFolder_`, `fileBelongsTo_`): the file's parent must be one of the app's folders, its name must
  carry the school id, and it must not be trashed.
* Removing a photo from a report trashes it only when no other saved report of that school references it.
  A server-side `TextFinder` on column M finds the candidate rows (`photoRefs_`).
* **Unused uploads are swept** (`sweepOrphanPhotos_`): a file of the current photos folder that no saved report
  uses is trashed 3 days after its upload date (an abandoned draft, or uploads made only to fill the owner's Drive).
  It runs at most once a day — from `api_bootstrap` (4 s budget) and the digest trigger — and processes upload days
  in order (`photoSweep`), finding each day's files with `Folder.searchFiles` on the modified time and the file
  name. A photo is "used" when a report saved on or after that day references it; photos of reports the supervisor
  deleted are kept (`photoKeep`). Trashed files can be restored from the Drive trash for 30 days.
* **Storage caps.** Uploads are capped per school (40 a day) and over all schools (300 MB a day, `counts.upb`;
  the supervisor's log notes the first refusal), and refused once the owner's storage is 90 % full, so a leaked
  link can neither fill the Drive (shared with Gmail on free accounts) nor push it past the point where mail stops.

### 5.5 Browser storage (`localStorage`, prefix `nabd:`, always wrapped in try/catch)

| key | page | content |
|---|---|---|
| `session` | admin | session token |
| `wizard` | admin | unfinished setup wizard (step + data) |
| `otpSentAt`, `otpCid` | admin | resend countdown; the challenge id the emailed code belongs to |
| `waysCollapsed` | admin | Schools page explanation collapsed |
| `school` | school (picker) | `{token, schoolName}` remembered after the code was entered once (the token is the general-link credential `g…`, never the private link); «خروج من هذا الجهاز» removes it |
| `draft:<token>:<date>` | school | autosaved answers incl. uploaded photo ids |
| `filledBy:<token>`, `last:<token>` | school | remembered filler name / last answers for suggestions |

## 6. Domain rules

### 6.1 Form fields

```
{ id:'f_xxxxxx', label (1–80, unique), type:'number'|'text'|'textarea'|'select'|'yesno'|'attendance'|'photos',
  required, help (≤140), kpi:null|'mode'|'lessons_planned'|'lessons_done'|'late_students',
  min/max (number), options[2–20, ≤40 chars] (select), rows ⊆ [students,teachers,staff] (attendance),
  maxCount 1–10 (photos) }
```
* There is at most one `attendance` field and one `photos` field, and each KPI can be used once.
* Presets (`PRESETS_`) are `standard` (default: «متابعة سير العملية التعليمية»), `basic` («الحضور والغياب فقط») and `extended` («موسّع»).
  Preset fields have stable ids, so switching presets reuses the same mirror columns.
* Answers are validated by `validateAnswers_` (cross-field rule: `lessons_done ≤ lessons_planned`). Photo ids are re-verified on the server.
* Derived values (`deriveReport_`) are computed on read, never stored:
  * per attendance row: total and absence percentage;
  * lessons: not activated and activation percentage;
  * mode, late students and photo count.
  Percentages have one decimal and are `null` when the denominator is 0.

### 6.2 Time, days and edit rules

* All server dates use `TZ = 'Asia/Riyadh'`. Dates are `yyyy-MM-dd`, times `HH:mm`, timestamps `yyyy-MM-dd HH:mm:ss`.
  The weekday is computed with UTC maths, and the code never depends on the project's time zone.
* A workday is a weekday in `schedule.workdays` that is not a holiday. The deadline applies only on workdays.
* Today's form state (`formState_`):
  * `open` before the deadline;
  * after the deadline: `late` if late sending is allowed or a report already exists, otherwise `closed`.
* Can today's report be edited? (`canEditToday_`)
  * No report yet: yes, unless the form is `closed`.
  * Returned for correction: always.
  * Approved by the supervisor: never.
  * Auto-approved (review is off and the supervisor never reviewed it): treated like pending.
  * Pending: yes while late sending is allowed or the deadline has not passed.
* A past date can be opened in two cases:
  * **correction**: the report of that day has status `returned`;
  * **late report** (`backfill`): the school has no report for that day, and the day is one of the last
    `schedule.backfillDays` workdays (0–7, default 2) on or after the school's first due day.
  A late report is always marked late.
* An edit keeps the original `submittedAt` and `late` and increments `edits`. A corrected report becomes
  `pending` again and keeps its `reviewNote`, which the supervisor sees as «صحّحت المدرسة…».
* A school added after the day's deadline is first due the next day (`firstDueDate_`).

### 6.3 Dashboard and statistics

* The day dashboard is built by `buildDay_` from plain data:
  * rows: active schools due that day, plus any school that has a report that day (deleted schools appear under their name snapshot);
  * sort order: missing, returned, pending, approved, then by name;
  * totals are computed from submitted reports only;
  * `canSubmit` says whether a school without a report can still send for that date, and drives the reminder buttons and the delete-confirm wording.
* The alerts:

  | Alert | Level | When |
  |---|---|---|
  | `high_absence` | danger | student absence ≥ threshold |
  | `teacher_absence` | warn | teacher absence ≥ threshold |
  | `low_activation` | warn | lesson activation < target |
  | `jump` | warn | student absence ≥ the average of the previous ≤ 10 workdays × (1 + jumpPct/100), at least 3 points above it, with at least 3 previous values |
  | `missing_streak` | danger | no report for ≥ 2 consecutive workdays, counted only after the deadline has passed |
  | `late` | info | report sent after the deadline |
  | `corrected` | info | a returned report has been resubmitted |
* Range statistics (`buildRange_`, at most 190 days) compute ratios from sums (Σ absent / Σ total), never averages of
  averages. Before today's deadline, today counts only the schools that already sent, so a morning view does not drag
  compliance down. `onTime ≤ expected` always holds.

## 7. Copy detection and installation states

* **Bound copy.** If `cfg.ssId` is set and differs from the active spreadsheet's id, this script is a copy of someone else's file.
  All Script Properties are wiped and the app starts as a new install.
* **Standalone copy.** With no bound spreadsheet, a stored `ownerEmail` that differs from the effective user means a copied project, so it also wipes.
  In a bound spreadsheet this email check deliberately does **not** wipe: a different effective user there means an editor deployed
  their own deployment, and the spreadsheet-id check already catches real copies.
* **No spreadsheet at all.** A standalone script with nothing stored creates «نبض المدارس — البيانات» in the owner's Drive and remembers its id.
* **Reset.** `menuReset` (spreadsheet menu only; the user must type «تصفير») clears the data rows, triggers and
  properties. Photos stay in Drive.

## 8. Server API

Every `api_*` function validates its argument types, lengths and ranges, ignores unknown keys, and throws
`Error('<Arabic message>')` for user errors. Two reserved messages are handled by the client:
`AUTH_REQUIRED` (the client shows the login, with a toast) and `NOT_SETUP`.

**Report object** (returned wherever a report appears):
```
{ date, status:'pending'|'approved'|'returned', answers:{fieldId:value}, filledBy, submittedAt, updatedAt,
  late, edits, reviewNote, reviewedAt,
  derived:{ attendance:{students|teachers|staff:{present,absent,total,absencePct}},
            lessons:{planned,done,notActivated,activationPct}|null, mode|null, lateStudents|null, photosCount } }
```

### 8.1 School side (no session; authorised by the private token)

| Function | Returns |
|---|---|
| `api_schoolForm(token, date?)` | `{ok:true, preview, school:{name,principal,students,teachers,staff,stage}, supervisor:{name,title}, systemTitle, fields, today, now, deadline, allowLate, reviewEnabled, date, isWorkday, isHoliday, state:'open'|'late'|'closed'|'correction'|'backfill', existing:Report|null, canEdit, returned:[{date,reviewNote,reviewedAt}] (≤10), missingDays:[date] }` or `{ok:false, code:'BAD_LINK'|'INACTIVE'|'NOT_SETUP'|'NOT_EDITABLE'|'ERROR', error}` (never throws) |
| `api_resolveSchool(schoolId, pin)` | `{ok:true, token}`: the general link exchanges the school and its 4-digit code for the private token |
| `api_uploadPhoto(token, {base64, mime, name, w, h})` | `{ok:true, photo:{id,name,w,h,size}}`. JPEG/PNG/WebP only (magic bytes checked), ≤ 3 MB (checked before decoding), 40 per school per day |
| `api_discardPhoto(token, fileId)` | `{ok:true}`: trashes the photo unless a saved report still uses it |
| `api_schoolPhoto(token, fileId)` | `{ok:true, dataUrl}`: thumbnails of this school's own photos |
| `api_submitReport(token, {answers, filledBy, date?})` | `{ok:true, receipt: Report & {schoolName}}`. The server decides the date (today, or a correction/late day it allows). Edit rules are checked twice: before validation and again inside the lock. 30 submissions per school per day |

### 8.2 Login and setup

| Function | Returns |
|---|---|
| `api_requestCode()` | `{ok, cid, emailMasked}`: emails a 6-digit code to `cfg.ownerEmail` (checks cooldown, hourly and 6-hour limits, and the mail quota). Every request is its own challenge: the code is stored under `otp:<sha256(cid)>` and only the page holding `cid` can redeem it |
| `api_verifyCode(cid, code, uaLabel)` | `{ok, token}`: 5 tries per challenge; creates a 30-day sliding session. The owner can also sign in without email through the spreadsheet menu: «🔗 رابط لوحة التحكم» issues a one-time `?login=<ticket>` link (10 minutes) that `doGet` trades for a session in `BOOT.session` |
| `api_logout(token)` / `api_logoutAll(token)` | `{ok}` |
| `api_completeSetup(token, {supervisor:{name,title,office,phone}, systemTitle, schoolsText, preset, webAppUrl?})` | `{ok, added}`: one time only. Saves settings and the preset form, and bulk-adds schools |

### 8.3 Supervisor (every function takes the session `token` first)

| Function | Returns |
|---|---|
| `api_bootstrap()` | `{ok, supervisor, systemTitle, schedule, review, links, alerts, digest, fields, baseUrl, generalLink, devMode, spreadsheetUrl, photosFolderUrl, today, now, ownerEmail, version, schoolsCount, storage:{used,limit}|null}` |
| `api_day(date?)` | `{date, today, isWorkday, isHoliday, isToday, now, deadline, allowLate, canSubmit, reviewEnabled, totals:{schools, submitted, missing, pending, approved, returned, late, students, teachers, staff, lessons, lateStudents, modes}, rows:[{school:{id,name,principal,phone,students,teachers,staff,stage,active,link}, report:Report|null, flags:[high_absence|teacher_absence|low_activation|jump|late|missing|missing_streak|returned|corrected]}], alerts:[{level,type,schoolId,text}], pendingOther:[{date,schoolId,schoolName}], returnedOther:[…]}` |
| `api_review(date, schoolId, action, note)` | `{ok, report}`. `action` is `approve`, `return` (note of 3–300 characters) or `reopen` (approved back to pending) |
| `api_approveAll(date)` | `{ok, count}` |
| `api_report(date, schoolId)` | `{ok, school, report, supervisor, systemTitle, fields}` (printable single-school report) |
| `api_photo(fileId)` | `{ok, dataUrl}` (only files in the app's folders) |
| `api_range(from, to)` | `{from, to, workdays, days:[{date,isWorkday,submitted,onTime,expected,compliancePct,studentAbsencePct,teacherAbsencePct,activationPct,late}], schools:[{id,name,submittedDays,onTimeDays,extraDays,expectedDays,compliancePct,avgStudentAbsencePct,avgTeacherAbsencePct,avgActivationPct,lateCount,returnedCount,modes}], totals:{compliancePct,avgStudentAbsencePct,avgTeacherAbsencePct,avgActivationPct,reports,modes}}` |
| `api_deleteReport(date, schoolId)` | `{ok}` (photos stay in Drive) |
| `api_schools()` | `{baseUrl, generalLink, devMode, schools:[{id,name,ministryNo,stage,principal,phone,students,teachers,staff,token,pin,active,createdAt,link}]}` |
| `api_saveSchool(school)` | `{ok, school}`: creates the school when no `id` is given |
| `api_bulkAddSchools(text)` | `{ok, added, skipped:[{line, reason}]}`. One school per line: `name[, principal[, phone[, students[, teachers[, staff]]]]]`. Separators are tab, `,`, `،` or `|`. A serial `م`/ministry-number first cell is dropped. At most 200 lines |
| `api_setSchoolActive(id, bool)` / `api_regenerateLink(id)` / `api_regeneratePin(id)` | `{ok, school}`. Regenerating the link invalidates the old link immediately |
| `api_deleteSchool(id)` | `{ok}` (the school's reports stay, with the school name snapshot) |
| `api_saveFields(fields)` / `api_applyPreset(key)` | `{ok, fields}` |
| `api_getSettings()` | everything in `cfg` that the UI needs, plus `holidays, baseUrl, generalLink, webAppUrl, detectedUrl, devMode, spreadsheetUrl, photosFolderUrl, storage, ownerEmail, version, presets` |
| `api_saveSettings(partial)` | `{ok}`. Validates each group. When the digest settings change, the `dailyDigest` trigger is replaced first; if Google refuses it, nothing is saved |

### 8.4 Triggers and menu

* **`dailyDigest(e)`** emails the owner a summary of the day: who sent and who did not, pending reviews, alerts and attendance totals.
  * It is sent on workdays only, and at most once per day.
  * It only runs when `e.triggerUid` matches one of this project's own triggers. Because `google.script.run` can reach any global, an
    anonymous call would otherwise claim (and suppress) the day's digest.
  * The trigger uses `nearMinute`, so it fires within about ±15 minutes of the chosen time. The email says so when it arrives before the deadline.
* **`onOpen`** adds the menu «📋 نبض المدارس»:
  * «🔗 رابط لوحة التحكم» shows the saved `/exec` URL, or deployment instructions;
  * «📖 خطوات التشغيل»;
  * «🧹 تصفير النظام…».

  The first two items call `ScriptApp.requireAllScopes`, so they re-ask for any permission the owner skipped.

## 9. Security model

* **Execute as owner, access Anyone.** An anonymous visitor can call any public function, so each one is either
  harmless or guarded:
  * `menu*` functions fail in web context, because `getUi()` throws;
  * `dailyDigest` checks its trigger id;
  * `include` only returns the page partials, which are public anyway.
* **Private links.** School tokens are 20 random alphanumerics (~119 bits) generated from `Utilities.getUuid()` material.
  Lookups are exact, with a constant-time compare (`safeEq_`). Inactive schools are rejected. Regenerating a link invalidates the old one.
* **General link.** The 4-digit school code is rate-limited (5 wrong tries per school per 15 minutes). The supervisor can switch the general link off.
  The picker reveals only active school names and ids.
* **Supervisor login.**
  * The one-time code is emailed only to the copy's owner. It is stored hashed (bound to the spreadsheet id), expires after 10 minutes, allows 5 tries,
    and is limited by a 60-second cooldown and 6 codes per hour / 10 per 6 hours.
  * Sessions are 64-hex random tokens, stored as SHA-256 hashes, valid 30 days and refreshed with use (every 12 h).
    At most 15 sessions exist. "Sign out of all devices" is available.
  * Before login, the supervisor page reveals only `publicStatus_()`.
* **Input.** Every argument is type-, length-, range- and enum-checked. Unknown keys are dropped. Photo ids must belong to
  the school and live in the app folder. Base64 size is checked before decoding.
* **XSS.**
  * Dynamic text goes through `App.html` (a tagged template that escapes every interpolation). URL attributes are scheme-checked.
  * Event handling uses `data-action` delegation; there are no inline handlers with user data.
  * QR SVG output is checked before insertion. Emails escape all user text (`escHtml_`).
* **Formula injection.** `safeCell_` prefixes `'` to any string that starts with `= + - @`, on every write. The tests
  assert that no formula is ever written.
* **Drive.** The manifest requests the full `drive` scope, because the built-in DriveApp service does not work with
  `drive.file`: creating folders and files needs `drive`. The code only touches its own folder and files (see §5.4).
* **What the supervisor's spreadsheet editors can see.** Anyone the supervisor adds as an editor of the spreadsheet can
  read every token and code in «المدارس». Do not share the data file.

## 10. Platform gotchas handled

| Gotcha | Handling |
|---|---|
| `google.script.run` turns a result containing a `Date` into `null` | the API returns strings only; the runtime test harness throws on Date/function/`undefined`-in-array |
| Sheets auto-converts `2026-10-14`, `09:00`, `0501…`, `TRUE`, `0123` | `'@'` formats on text columns, defensive reads (`cellStr_`, `toBool_`, `toInt_`) |
| User text starting with `=` becomes a formula | `safeCell_` on every string written |
| Concurrent submissions at the same minute | script lock around every write path; the Drive upload runs outside the lock |
| `SpreadsheetApp.getUi()` throws in web-app context | only called from `onOpen` / `menu*` |
| Properties 9 KB/value, 500 KB total; Cache 100 KB, 6 h | chunked properties, small cache values, bounded lists |
| `ScriptApp.getService().getUrl()` returns the `/dev` URL in the test deployment and is unreliable in menus and triggers | links are built from the saved `cfg.webAppUrl` (`…/exec`, captured on first open from `/exec`, editable in the wizard and in Settings → «طرق الإرسال»). `/dev` is never rewritten into a link; menus and triggers use only the saved URL. Opening from `/dev` shows a warning |
| Granular consent: the owner may untick some permissions | permission errors are detected (`isPermErr_`, `ScriptApp.getAuthorizationInfo`) and turned into Arabic fix-it text. The deploy steps say to tick «تحديد الكل». The menu items re-request permissions |
| DriveApp `getFileById` returns trashed files and any file of the owner | parent-folder, name and trash checks (`fileBelongsTo_`) |
| A full Drive makes `createFile` fail | clear Arabic message; dashboard warning at 85 %; photos compressed to 1280 px, JPEG quality 0.72 (~150–250 KB) |
| Hand-edited sheets (inserted column, renamed sheet, typed rows) | header guard, sheet-id rename-back, row repair, mirror re-match by header text |
| A tab left open overnight | the school page reloads today's form instead of filing yesterday's answers; the dashboard moves to the new day |
| Sandboxed iframe on `*.googleusercontent.com` | links leaving the app use `target="_blank"`/`_top`; `localStorage` wrapped in try/catch; clipboard falls back to `execCommand`, then to a selectable modal |
| Bidi: phone numbers, `/exec` and URLs inside Arabic text | LTR runs (`dir="ltr"`, `<bdi>`, LRI…PDI isolates) |

## 11. Client architecture

* **`Styles.html`** is the design system: tokens on `:root` (brand primary `#0E7C66`, an accent, and status
  colours) plus components (`.card`, `.kpi`, `.btn*`, `.field`, `.stepper`, `.choice`, `.att-table`, `.uploader`,
  `.badge`, `.alert`, `.modal` (a bottom sheet on phones), `.bottom-nav`, `.doc` for print, …).
  * Fonts: IBM Plex Sans Arabic from Google Fonts, falling back to system fonts.
  * Touch targets are at least 40–48 px. `prefers-reduced-motion` is respected, and `@media print` prints only the active `.doc`.
* **`Common.html`** defines the global `App`:
  * `App.call` wraps `google.script.run` in a Promise and dispatches `app:auth-required`;
  * `App.html`, `App.raw`, `App.render` render safely;
  * dates and times in Riyadh, with Hijri dates (umalqura) and Latin digits;
  * `App.modal`, `App.confirm`, `App.prompt`, `App.toast`, `App.copy`;
  * `App.wa` builds `wa.me` links (`05…` → `9665…`);
  * `App.store` wraps `localStorage`;
  * `App.image.compress` compresses photos on a canvas (1280 px, JPEG);
  * `App.print`;
  * `App.svg.line`, `.bars`, `.donut`, `.ring` draw hand-written RTL inline-SVG charts (no chart library).
  * QR codes lazy-load `qrcode-generator` from cdnjs.
* **`School.html`** is mobile-first: date strip and deadline chip, smart sections, autosaved draft, uploads, sticky
  submit bar, receipt, correction banner, the «لم ترسل تقرير يوم سابق؟» card, preview mode and friendly error pages.
* **`Admin.html`** is a state machine: wizard (not set up), login (no session), app shell. The shell shows top tabs on desktop and
  a bottom bar on phones, with five views (`today`, `schools`, `stats`, `form`, `settings`). Today auto-refreshes every 60 s while visible.

## 12. Testing harness

No npm install is possible on the build machine. The tests use Node 22 built-ins plus `playwright-core@1.56.1`, installed
globally (the npm scripts set `NODE_PATH=/opt/node-tools/node_modules`), and Chromium at `/opt/pw-browsers/chromium`.

```bash
npm run test:unit     # node --test test/unit.js        (~150 tests, a few seconds)
npm run test:bundle   # node --test test/bundle.js      (the built single-file bundle)
npm run test:e2e      # node --test test/e2e.js         (~40 Playwright scenarios; rewrites docs/screenshots)
                      #   E2E_SHOTS=0 writes no screenshots; E2E_SHOTS=all writes every capture + a PDF
npm test              # unit + bundle + e2e
npm run dev           # local server on http://localhost:8787 with a fresh mock environment
npm run build:bundle  # tools/build-bundle.js → dist/Code.gs + dist/appsscript.json
npm run build         # build:bundle + build:demo (tools/build-demo.js → dist/demo.html)
```

* **`test/gas-mock.js`** mocks every service the app uses: SpreadsheetApp, DriveApp, Properties, Cache, Lock, Mail, Session,
  ScriptApp, HtmlService and Utilities. It reproduces the behaviours that break real apps:
  * Sheets auto-conversion, and formulas created from user text (recorded in `env.formulaWrites`);
  * range-bounds errors, and `getUi()` throwing in web context;
  * Properties/Cache size limits and TTLs;
  * DriveApp returning trashed files, and Java-signed blob bytes;
  * the OAuth scopes in `src/appsscript.json`, which the mock enforces on every call (granular consent can be simulated);
  * a controllable clock (`env.clock.set('2026-10-14T07:30')`, wall time in Riyadh).

  The whole state is plain JSON (`snapshot()` / `restore()`).
* **`test/runtime.js`** loads `Code.gs` into a `vm` context as a **fresh execution per call**, as Apps Script does.
  `app.call()` enforces the `google.script.run` rules: public functions only, JSON-cloned arguments, no Date in results.
  Other entry points: `app.doGet()`, `app.runTrigger()` (with a real trigger id), `app.runMenu()` and `app.onOpen()`.
* **`test/server.js`** serves the pages through the runtime and injects a `google.script.run` shim.
  * Like the real iframe, it rewrites the URL, so pages must rely on BOOT rather than `location.search`.
  * It reports a stand-in deployment URL, `https://script.google.com/macros/s/AKfycbLocalDevServer/exec`, and the shim
    sends clicks on it back to localhost. Copied links in the dev UI point at the stand-in.
  * Test endpoints include `/__mail/last-code` (the OTP), `/__clock`, `/__reset`, `/__state`, `/__trigger`, `/__fail` and `/__latency`.
    The server binds to 127.0.0.1 only.
* **`test/unit.js`** groups tests by area: platform contract, routing, OTP, sessions, schools, bulk text, general link,
  form states, validation, photos, submission, review, dashboard, statistics, fields and mirror columns, settings,
  digest, copy detection, menu, storage invariants, scopes, web-app URL, hand-edited sheets, single-file bundle,
  late reports and phones.
* **`test/bundle.js`** builds the bundle, then loads `dist/Code.gs` alone, with `dist/appsscript.json` and no `.html`
  files. Every scenario runs side by side against the multi-file project, with identical clocks and seeds, and the pages,
  API results, emails and dialogs must be identical. It also checks that the build is deterministic, that it survives
  CRLF line endings, and that it fails clearly on bad input.
* **`test/e2e.js`** runs real UI flows on mobile and desktop viewports:
  * wizard via the emailed code, login, schools and bulk add;
  * private-link form with photos, the review loop, the general link and code;
  * late, closed and holiday days;
  * dashboard and alerts, approve-all;
  * form builder, statistics and CSV, printing;
  * XSS, formula text, expired session, network failure with draft;
  * late reports for missed days, midnight edge cases, the 360 px layout, and `/dev` handling.

  Every scenario asserts that no formula was written and there were no server warnings. Screenshots are saved to `docs/screenshots/`:
  by default only the curated set the README uses (`DOC_SHOTS` in `test/e2e.js`); `E2E_SHOTS=all` writes every capture.

What the mock cannot prove; check these on a real deployment before a release:
* `getUrl()` in menus and triggers;
* the granular consent screen;
* the exact text of DriveApp permission errors (matched with a loose regex);
* `TextFinder` on the answers column;
* real mail delivery and trigger timing.

## 13. Release process

1. Change `src/`. Run `npm test` (unit, bundle and e2e) and keep every suite green. Run `node --check src/Code.gs`.
2. Bump `APP_VERSION` in `src/Code.gs` and `version` in `package.json`, and update the version expectations in
   `test/unit.js` and the e2e boot checks. Bump the version whenever the manifest scopes change, because existing
   owners must approve new permissions once.
3. `npm run build` (or just `npm run build:bundle`) runs `tools/build-bundle.js` and writes two files:
   * `dist/Code.gs`:
     * a short header with the version, build id and the install steps;
     * `src/Code.gs`, byte for byte;
     * `var NABD_EMBEDDED_FILES_ = {Styles, Common, School, Admin}` as JSON string literals. Invisible and bidi
       characters are written as `\uXXXX`, so copy-paste cannot alter them.
   * `dist/appsscript.json`.

   The build is deterministic and re-checks its own output before writing. Run `npm run test:bundle`, and use
   `node tools/build-bundle.js --check` to confirm that the committed `dist/` matches `src/`. The unit test
   "single-file bundle" proves that the embedded pages render identically.
4. Update the template: open it, then «الإضافات» ← «Apps Script». Replace the content of `Code.gs` with `dist/Code.gs` and save.
   **Do not deploy the template, and do not run the wizard in it.**
5. Tell the supervisors. Each one pastes the new `Code.gs` into their own copy, then «نشر» ← «إدارة عمليات النشر» ← (pencil) Edit ←
   «الإصدار: إصدار جديد» ← «نشر». Editing the existing deployment keeps the `/exec` URL and every school link.
   If permissions changed, the owner opens the menu «📋 نبض المدارس» ← «📖 خطوات التشغيل» and ticks «تحديد الكل».
6. Data needs no migration. Configuration is deep-merged over the defaults, so new settings get their defaults, and the
   sheets are repaired lazily.

## 14. Known limits

* **Apps Script quotas (consumer Gmail).**
  * About 100 email recipients per day. The app sends only login codes and the optional digest.
  * Runtime is limited per execution, and trigger runtime per day.
  * All writes are serialised by one script lock (30 s wait). Many schools pressing «إرسال» in the same second wait for each other.
    The app is sized for one supervisor's schools (tens, not thousands).
* **Growth.**
  * Every request reads the 5-column index of the whole «التقارير» sheet. About 50 schools × 180 days is about 9 000 rows a year, which is fine.
    After several years, consider moving old rows to another file. There is no automatic archive.
  * Statistics cover at most 190 days per query.
* **Strict header guard.** Renaming one of the 13 fixed header cells (e.g. «الجوال» → «رقم الجوال») blocks all
  school pages until it is restored. This is intentional, and the supervisor's message names the column, but the supervisor experiences it as an outage.
* **Single user.** One copy serves one supervisor. There are no roles or delegated reviewers. Spreadsheet editors see everything (tokens included).
* **Photos.** Photos use the supervisor's own Drive storage (15 GB shared with Gmail on free accounts). Deleting a report or a school
  does not delete its photos. The compressed photos (1280 px) are meant for evidence on screen and A4 prints, not archival quality.
* **External resources.** Google Fonts and the QR library come from CDNs. Offline, the pages fall back to system fonts and the
  QR dialog shows an Arabic error. Everything else works.
* **Digest timing.** The digest fires within ±15 minutes of the chosen time (a Google trigger property).
* **Browsers.** Hijri dates use `Intl` with the `islamic-umalqura` calendar in the browser. Where that is missing, a tabular
  Hijri calculation is used instead, and it can differ from Umm al-Qura by a day.
