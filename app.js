"use strict";
const CFG = window.AMH_CONFIG || {};
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k instanceof Node ? k : String(k)); }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "hidden") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  return el;
}
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 16);
const pad = n => String(n).padStart(2, "0");
const toIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => toIso(new Date());
const parseIso = s => new Date(s.slice(0, 10) + "T00:00:00");
function addMonths(iso, m) { const d = parseIso(iso); const day = d.getDate(); d.setMonth(d.getMonth() + m); if (d.getDate() < day) d.setDate(0); return toIso(d); }
const daysUntil = iso => Math.round((parseIso(iso) - parseIso(todayIso())) / 86400000);
const fmtDate = iso => iso ? parseIso(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtTs = ts => ts ? new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const clone = o => JSON.parse(JSON.stringify(o));
const safeSeg = s => String(s).trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "unknown";
function toast(msg, tone) { const t = h("div", { class: "toast" + (tone ? " " + tone : "") }, msg); $("#toast").append(t); setTimeout(() => t.remove(), 4000); }
async function busy(btn, fn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Working…";
  try { return await fn(); }
  catch (e) { console.error(e); toast(errText(e), "bad"); }
  finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
}
function errText(e) {
  const m = (e && (e.message || e.error_description)) || "";
  if (/Invalid login credentials/i.test(m)) return "That email and password don't match.";
  if (/row-level security|violates|permission|not allowed/i.test(m) && (S.isAdmin || S.approver)) return "The database refused this action: " + m;
  if (/row-level security|violates|permission/i.test(m)) return "The submission was refused. Check your employee ID, or contact the credentials office.";
  if (/rate limit/i.test(m)) return "Too many attempts. Wait a few minutes and try again.";
  if (/exceeded the maximum allowed size|Payload too large/i.test(m)) return "That file is too large.";
  if (/mime type/i.test(m)) return "That file type isn't accepted. Use PDF, JPG or PNG.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Can't reach the server. Check your connection and try again.";
  return m || "Something went wrong. Try again.";
}
function must(res) { if (res.error) throw res.error; return res.data; }
function armed(btn, label, fn) {
  let t; btn.addEventListener("click", () => {
    if (!btn.classList.contains("armed")) { btn.classList.add("armed"); btn.dataset.l = btn.textContent; btn.textContent = label; t = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = btn.dataset.l; }, 4000); return; }
    clearTimeout(t); btn.classList.remove("armed"); btn.textContent = btn.dataset.l; fn();
  });
  return btn;
}

/* ---------- state ---------- */
const S = {
  ready: false, isAdmin: false, isHR: false, approver: false, role: "", depts: [], myName: "", queue: [], email: "",
  matrix: null, jds: [], staff: [], roster: [], rq: "", tab: "compliance", built: null,
  person: null, sent: {}, signed: {}, extras: [], finished: false,
  f: { dept: "", status: "", q: "" }, draft: null, dirty: false
};
let sb = null;
const WARN_DAYS = 60;
const MAX_PDF = 5 * 1024 * 1024;
const TONE = { missing: "bad", expired: "bad", rejected: "bad", pending: "pend", expiring: "warn", valid: "ok" };
const SCFHS_CLASSES = ["Consultant", "Senior Registrar / Senior Specialist", "Registrar / Specialist", "Resident", "General Practitioner", "Senior Specialist Nurse", "Specialist Nurse", "Nurse Technician", "Other"];
// Urgent notice shown at the top of the staff page. Set to null to remove it.
const ANNOUNCE = {
  en: ["Upload your credentials today for the CBAHI ESR survey", "In preparation for the CBAHI Essential Safety Requirements (ESR) survey, every staff member must upload their current credentials today. Missing or expired credentials will be recorded as non-compliant during the survey."],
  ar: ["يرجى رفع الشهادات والمؤهلات اليوم استعداداً لزيارة سباهي لمتطلبات السلامة الأساسية", "استعداداً لزيارة المركز السعودي لاعتماد المنشآت الصحية (سباهي) لتقييم متطلبات السلامة الأساسية (ESR)، يجب على جميع الموظفين رفع شهاداتهم ومؤهلاتهم السارية اليوم. ستُسجَّل الشهادات الناقصة أو المنتهية كعدم امتثال أثناء الزيارة."]
};
function announceBanner() {
  if (!ANNOUNCE) return null;
  const part = (lang, [t, b]) => h("div", { lang, dir: lang === "ar" ? "rtl" : "ltr" }, h("strong", { style: "display:block;margin-bottom:2px" }, t), h("span", null, b));
  return h("div", { class: "announce", role: "alert" }, part("en", ANNOUNCE.en), part("ar", ANNOUNCE.ar));
}
const credExtra = item => item ? [item.classification, item.specialty].filter(Boolean).join(", ") : "";

/* ---------- requirement logic ---------- */
const M = () => S.matrix || { credentials: [], departments: [], positions: [], rules: [] };
const deptName = id => id === "*" ? "All departments" : (M().departments.find(d => d.id === id) || {}).name || id || "—";
function requiredFor(p, m = M()) {
  if (!p) return [];
  const ids = new Set();
  for (const r of m.rules || []) {
    if ((r.dept === "*" || r.dept === p.dept) && (!r.positions || !r.positions.length || r.positions.includes(p.position))) (r.creds || []).forEach(c => ids.add(c));
  }
  return (m.credentials || []).filter(c => ids.has(c.id));
}
// Library job descriptions (dept TITLE_JD) are chosen by job title on the form; the others match by department and position.
const TITLE_JD = "@title";
const titleJds = () => S.jds.filter(j => !j.archived && j.dept === TITLE_JD);
// A department head signs two job descriptions: their own job title's and their leadership one (jobCode2).
const HEAD_DESIG = "Department Head";
function jdsFor(p) {
  if (!p) return [];
  const act = S.jds.filter(j => !j.archived);
  const lib = code => code ? act.filter(j => j.dept === TITLE_JD && j.code === code) : [];
  const own = lib(p.jobCode);
  const base = own.length ? own : act.filter(j => j.dept !== TITLE_JD && (j.dept === "*" || j.dept === p.dept) && (!j.positions || !j.positions.length || j.positions.includes(p.position)));
  const extra = p.designation === HEAD_DESIG ? lib(p.jobCode2).filter(j => !base.includes(j)) : [];
  return [...base, ...extra];
}
// Normalises a jd_signatures row (approval chain: employee -> head/director -> HR).
const normSig = r => ({ id: r.id, employeeId: r.employee_id, fullName: r.full_name, dept: r.dept, position: r.position, designation: r.designation || "", jdId: r.jd_id, version: r.version,
  typedName: r.typed_name, signedAt: r.signed_at, path: r.signature_path, fileName: "signature.png",
  mgrName: r.mgr_name, mgrRole: r.mgr_role, mgrSignedAt: r.mgr_signed_at, mgrPath: r.mgr_signature_path, hrName: r.hr_name, hrSignedAt: r.hr_signed_at, hrPath: r.hr_signature_path });
const mgrLabel = sig => sig && sig.designation === HEAD_DESIG ? "director" : "department head";
function jdStage(sig, j) {
  if (!sig) return { k: "emp", label: "Not signed", tone: "warn" };
  if (sig.version !== j.version) return { k: "emp", label: `Signed v${sig.version} only`, tone: "warn" };
  if (!sig.mgrSignedAt) return { k: "mgr", label: "Waiting for " + mgrLabel(sig), tone: "pend" };
  if (!sig.hrSignedAt) return { k: "hr", label: "Waiting for HR", tone: "pend" };
  return { k: "done", label: "Fully signed", tone: "ok" };
}
const jobTitle = code => { const j = code && S.jds.find(x => x.dept === TITLE_JD && x.code === code); return j ? j.title : ""; };
function evalCred(c, item) {
  if (!item) return { k: "missing", label: "Not submitted" };
  const exp = item.expiryDate || null, d = exp ? daysUntil(exp) : null;
  if (exp && d < 0) return { k: "expired", label: "Expired", exp, d };
  if (item.status === "rejected") return { k: "rejected", label: "Returned", exp, d, note: item.note };
  if (item.status !== "verified") return { k: "pending", label: "Awaiting review", exp, d };
  if (exp && d <= WARN_DAYS) return { k: "expiring", label: d === 0 ? "Expires today" : `Expires in ${d} day${d === 1 ? "" : "s"}`, exp, d };
  return { k: "valid", label: "Verified", exp, d };
}
function summarize(p) {
  const rows = requiredFor(p).map(c => { const item = p.creds[c.id]; return { c, item, ...evalCred(c, item) }; });
  const jds = jdsFor(p).map(j => { const sig = p.signatures[j.id]; return { j, sig, signed: !!sig && sig.version === j.version }; });
  const n = t => rows.filter(r => TONE[r.k] === t).length;
  const counts = { bad: n("bad"), pend: n("pend"), warn: n("warn"), ok: n("ok") };
  const jdOut = jds.filter(x => !x.signed).length;
  let overall;
  if (!p.hasSubmitted) overall = { k: "bad", label: "Not yet submitted" };
  else if (counts.bad) overall = { k: "bad", label: "Action needed" };
  else if (jdOut) overall = { k: "warn", label: "Signature needed" };
  else if (counts.pend) overall = { k: "pend", label: "Awaiting review" };
  else if (counts.warn) overall = { k: "warn", label: "Expiring soon" };
  else overall = { k: "ok", label: rows.length ? "Compliant" : "No requirements" };
  return { rows, jds, counts, jdOut, overall };
}
// Additional (optional) certificates: cred_id is "extra:<id>:<name typed by the staff member>".
const EXTRA = "extra:";
const extraTitle = credId => credId.slice(EXTRA.length).split(":").slice(1).join(":") || "Additional certificate";
const extraRows = p => (p.extras || []).map(item => { const c = { id: item.credId, short: "+", name: item.title, extra: true }; return { c, item, ...evalCred(c, item) }; })
  .sort((a, b) => (b.item.uploadedAt || "").localeCompare(a.item.uploadedAt || ""));
function pendingQueue() {
  const out = [];
  for (const p of S.staff) for (const r of [...summarize(p).rows, ...extraRows(p)]) if (r.k === "pending") out.push({ p, ...r });
  return out.sort((a, b) => (a.item.uploadedAt || "").localeCompare(b.item.uploadedAt || ""));
}

/* ---------- data ---------- */
async function fetchAll(table) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const rows = must(await sb.from(table).select("*").range(from, from + size - 1));
    out.push(...rows); if (rows.length < size) return out;
  }
}
async function loadPublic() {
  const [m, jds] = await Promise.all([sb.from("settings").select("value").eq("key", "matrix").maybeSingle(), fetchAll("job_descriptions")]);
  S.matrix = must(m) ? m.data.value : null;
  S.jds = jds.map(j => ({ id: j.id, title: j.title, code: j.code, dept: j.dept, positions: j.positions || [], path: j.file_path, fileName: j.file_name, version: j.version, archived: j.archived, category: j.category || "", history: j.history || [], updatedAt: j.updated_at }));
}
async function refresh() {
  await loadPublic();
  if (S.isAdmin) {
    const [subs, sigs, roster] = await Promise.all([fetchAll("current_submissions"), fetchAll("jd_signatures"), fetchAll("roster")]);
    const by = {};
    const person = (eid) => { const k = eid.trim().toLowerCase(); return by[k] || (by[k] = { uid: k, employeeId: eid.trim(), fullName: "", dept: "", position: "", mobile: "", jobCode: "", jobCode2: "", designation: "", updatedAt: "", creds: {}, extras: [], signatures: {}, onRoster: false, hasSubmitted: false }); };
    const touchPerson = (u, r, ts) => { u.hasSubmitted = true; if (!u.updatedAt || ts > u.updatedAt) { u.updatedAt = ts; if (!u.onRoster || !u.fullName) u.fullName = r.full_name; if (!u.onRoster || !u.dept) { u.dept = r.dept; u.position = r.position; } if (r.mobile) u.mobile = r.mobile; if (r.job_code) u.jobCode = r.job_code; if ("designation" in r) { u.designation = r.designation || ""; u.jobCode2 = r.job_code2 || ""; } } };
    for (const r of roster) { const u = person(r.employee_id); u.onRoster = true; u.fullName = r.full_name || ""; u.dept = r.dept || ""; u.position = r.position || ""; }
    for (const r of subs) { const u = person(r.employee_id);
      if (r.cred_id.startsWith(EXTRA)) { u.extras.push({ id: r.id, credId: r.cred_id, title: extraTitle(r.cred_id), number: r.number, issueDate: r.issue_date, expiryDate: r.expiry_date, path: r.file_path, fileName: r.file_name, fileType: r.file_type, uploadedAt: r.uploaded_at, status: r.status, note: r.review_note, asName: r.full_name }); touchPerson(u, r, r.uploaded_at); continue; }
      u.creds[r.cred_id] = { id: r.id, number: r.number, classification: r.classification, specialty: r.specialty, issueDate: r.issue_date, expiryDate: r.expiry_date, path: r.file_path, fileName: r.file_name, fileType: r.file_type, uploadedAt: r.uploaded_at, status: r.status, note: r.review_note, asName: r.full_name };
      touchPerson(u, r, r.uploaded_at); }
    for (const r of sigs) { const u = person(r.employee_id); const cur = u.signatures[r.jd_id];
      if (!cur || r.version > cur.version || (r.version === cur.version && r.signed_at > cur.signedAt)) u.signatures[r.jd_id] = normSig(r);
      touchPerson(u, r, r.signed_at); }
    S.staff = Object.values(by);
    S.roster = roster.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "") || a.employee_id.localeCompare(b.employee_id));
  }
  render();
}
async function reload(msg) { await refresh(); if (msg) toast(msg); }

/* ---------- files ---------- */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That image could not be read.")); i.src = url; });
    const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.85, blob;
    do { blob = await new Promise(r => c.toBlob(r, "image/jpeg", q)); q -= 0.1; } while (blob.size > 900000 && q > 0.4);
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
async function prepareFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImg = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (!isPdf && !isImg) throw new Error("Use a PDF, JPG or PNG file.");
  if (isPdf && file.size > MAX_PDF) throw new Error(`This PDF is ${(file.size / 1048576).toFixed(1)} MB. The limit is 5 MB. Scan at a lower resolution or upload a photo instead.`);
  if (isImg) return { blob: await compressImage(file), type: "image/jpeg", ext: "jpg", name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  return { blob: file, type: "application/pdf", ext: "pdf", name: file.name };
}
async function uploadTo(bucket, path, blob, type) { must(await sb.storage.from(bucket).upload(path, blob, { contentType: type, upsert: false })); return path; }
async function getFile(bucket, path) { return must(await sb.storage.from(bucket).download(path)); }
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
let pdfReady;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("The PDF viewer could not load.")); document.head.append(s); }); }
function loadPdfJs() {
  if (!pdfReady) pdfReady = (async () => {
    const base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    await loadScript(base + "pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.js";
  })();
  return pdfReady;
}
// Renders each PDF page to a JPEG data URL (for the printable copy).
async function pdfToImages(buf, maxPages = 30) {
  await loadPdfJs();
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas"); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(c.toDataURL("image/jpeg", 0.88));
  }
  return out;
}
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const escHtml = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDateTime = ts => ts ? new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
// Opens a printable copy: the job description pages, then an approval page with every signature collected so far.
async function printSignedJd(sig) {
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups for this site to print.", "bad"); return; }
  w.document.write("<!doctype html><title>Preparing…</title><p style='font:16px system-ui;padding:24px'>Preparing the signed job description…</p>");
  try {
    const j = S.jds.find(x => x.id === sig.jdId);
    if (!j) throw new Error("This job description is no longer in the portal.");
    const pdfVersion = j.version === sig.version ? j : (j.history || []).map(x => ({ path: x.file_path, version: x.version })).find(x => x.version === sig.version);
    if (!pdfVersion) throw new Error(`The file for version ${sig.version} isn't available.`);
    const [pages, empImg, mgrImg, hrImg] = await Promise.all([
      getFile("jds", pdfVersion.path).then(b => b.arrayBuffer()).then(b => pdfToImages(b)),
      getFile("credentials", sig.path).then(blobToDataUrl).catch(() => ""),
      sig.mgrPath ? getFile("credentials", sig.mgrPath).then(blobToDataUrl).catch(() => "") : "",
      sig.hrPath ? getFile("credentials", sig.hrPath).then(blobToDataUrl).catch(() => "") : ""]);
    const logo = await fetch("logo.png").then(r => r.blob()).then(blobToDataUrl).catch(() => new URL("logo.png", location.href).href);
    const st = jdStage(sig, j);
    const block = (role, name, when, img, pending) => `<div class="sb"><div class="role">${escHtml(role)}</div>
      <div class="img">${img ? `<img src="${img}" alt="Signature">` : `<span class="pending">${escHtml(pending)}</span>`}</div>
      <table><tr><th>Name</th><td>${escHtml(name || "")}</td></tr><tr><th>Date &amp; time</th><td>${escHtml(fmtDateTime(when))}</td></tr></table></div>`;
    const mgrRole = sig.designation === HEAD_DESIG ? "Director" : "Department Head";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(`${j.code ? j.code + " " : ""}${j.title} - ${sig.fullName} (signed)`)}</title>
<style>@page{size:A4;margin:12mm} *{box-sizing:border-box} body{margin:0;font:11pt/1.45 Carlito,Calibri,Arial,sans-serif;color:#0F1E17}
.page{page-break-after:always} .page img{width:100%;display:block} .bar{display:none}
@media screen{body{background:#e9efec} .page,.sig{max-width:820px;margin:16px auto;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.15)} .sig{padding:28px} .bar{display:flex;gap:8px;justify-content:center;padding:12px;position:sticky;top:0;background:#003825} .bar button{font:inherit;padding:8px 16px;border-radius:8px;border:0;cursor:pointer} .bar .p{background:#00C576;color:#003825;font-weight:700}}
.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #016B43;padding-bottom:8px;margin-bottom:16px} .head img{height:46px} .head .t{text-align:right;color:#016B43;font-weight:700;font-size:10pt}
h1{font-size:16pt;margin:0 0 4px} .muted{color:#5F6478} table.info{width:100%;border-collapse:collapse;margin:12px 0 18px} table.info th,table.info td{border:1px solid #B9CFC3;padding:6px 8px;text-align:left;font-size:10pt;vertical-align:top} table.info th{background:#D5E6DD;color:#003825;width:22%}
.sbs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} .sb{border:1px solid #B9CFC3;border-radius:6px;padding:8px} .sb .role{font-weight:700;color:#003825;background:#D5E6DD;margin:-8px -8px 8px;padding:6px 8px;border-radius:6px 6px 0 0}
.sb .img{height:80px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #B9CFC3;margin-bottom:6px} .sb .img img{max-height:76px;max-width:100%} .pending{color:#A11C29;font-size:9.5pt}
.sb table{width:100%;font-size:9pt;border-collapse:collapse} .sb th{text-align:left;color:#5F6478;font-weight:400;width:40%;padding:2px 0} .sb td{padding:2px 0}
.ack{font-size:9.5pt;margin:14px 0} .status{display:inline-block;padding:3px 10px;border-radius:99px;font-weight:700;font-size:9.5pt;background:${st.k === "done" ? "#D9F2E5;color:#0B5A38" : "#FCE9D2;color:#8A4700"}} .foot{margin-top:18px;font-size:8.5pt;color:#5F6478}</style></head><body>
<div class="bar"><button class="p" onclick="print()">Print / Save as PDF</button><button onclick="close()">Close</button></div>
${pages.map(src => `<div class="page"><img src="${src}" alt="Job description page"></div>`).join("")}
<div class="sig"><div class="head"><img src="${escHtml(logo)}" alt="Almather Hospital"><div class="t">JOB DESCRIPTION<br>ACKNOWLEDGEMENT &amp; APPROVAL</div></div>
<h1>${escHtml(j.title)}</h1><div class="muted">${escHtml([j.code, "Version " + sig.version].filter(Boolean).join(" · "))}</div>
<table class="info"><tr><th>Employee name</th><td>${escHtml(sig.fullName)}</td><th>Employee ID</th><td>${escHtml(sig.employeeId)}</td></tr>
<tr><th>Department</th><td>${escHtml(deptName(sig.dept))}</td><th>Position</th><td>${escHtml(sig.position || "")}</td></tr>
<tr><th>Designation</th><td>${escHtml(sig.designation || "—")}</td><th>Status</th><td><span class="status">${escHtml(st.label)}</span></td></tr></table>
<p class="ack"><b>Employee:</b> I have read this job description, understand the duties and responsibilities it sets out, and accept it as the description of my role at AlMather Hospital.<br>
<b>${escHtml(mgrRole)}:</b> I have reviewed this job description with the employee and confirm it accurately describes their role.<br>
<b>HR Manager:</b> Approved on behalf of Human Resources as the employee's job description.</p>
<div class="sbs">${block("Employee", sig.typedName, sig.signedAt, empImg, "Not signed")}${block(mgrRole, sig.mgrName, sig.mgrSignedAt, mgrImg, "Awaiting signature")}${block("HR Manager", sig.hrName, sig.hrSignedAt, hrImg, "Awaiting signature")}</div>
<div class="foot">Signed electronically through the AMH Staff Credentials Portal. Printed ${escHtml(fmtDateTime(new Date().toISOString()))}${S.email ? " by " + escHtml(S.email) : ""}. Uncontrolled when printed; the electronic record is the reference.</div></div>
<script>window.addEventListener("load",()=>setTimeout(()=>print(),400))<\/script></body></html>`;
    w.document.open(); w.document.write(html); w.document.close();
  } catch (e) {
    console.error(e);
    w.document.body.innerHTML = "<p style='font:16px system-ui;padding:24px;color:#A11C29'>The signed copy couldn't be prepared: " + escHtml(errText(e)) + "</p>";
  }
}
async function renderPdf(box, buf) {
  await loadPdfJs();
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  box.replaceChildren();
  const w = Math.min(880, box.clientWidth || 800), dpr = Math.min(2, window.devicePixelRatio || 1);
  const pages = Math.min(doc.numPages, 20);
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (w / v1.width) * dpr });
    const c = h("canvas", { width: Math.floor(vp.width), height: Math.floor(vp.height), "aria-label": `Page ${n}` });
    c.style.width = "100%";
    box.append(c);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  }
  if (doc.numPages > pages) box.append(h("p", { class: "muted" }, `Showing the first ${pages} of ${doc.numPages} pages. Download to see the rest.`));
}
async function showDoc(title, sub, getBlob, fileName) {
  const box = h("div", { class: "viewer" }, h("p", { class: "muted" }, "Opening file…"));
  const dl = h("button", { class: "btn", disabled: true }, "Download");
  openModal({ title, sub, body: box, foot: [dl, h("button", { class: "btn primary", onclick: closeModal }, "Close")], wide: true });
  try {
    const blob = await getBlob();
    dl.disabled = false; dl.onclick = () => saveBlob(fileName || "document", blob);
    if ((blob.type || "").startsWith("image/")) box.replaceChildren(h("img", { src: URL.createObjectURL(blob), alt: title }));
    else await renderPdf(box, await blob.arrayBuffer());
  } catch (e) { console.error(e); box.replaceChildren(h("p", { class: "err" }, "The preview couldn't be shown. " + errText(e)), h("p", { class: "muted" }, "Use Download to open the file on your device.")); }
}
const viewStaffFile = (meta, title) => showDoc(title, meta.fileName, () => getFile("credentials", meta.path), meta.fileName);
const jdBlob = path => () => getFile("jds", path);

/* ---------- modal ---------- */
function onEsc(e) { if (e.key === "Escape") closeModal(); }
function closeModal() { const m = $("#modal"); m.hidden = true; m.replaceChildren(); document.removeEventListener("keydown", onEsc); }
function openModal({ title, sub, body, foot, wide }) {
  const m = $("#modal"); m.replaceChildren();
  const box = h("div", { class: "modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "m-head" }, h("div", null, h("h2", null, title), sub ? h("p", { class: "muted" }, sub) : null), h("button", { class: "icon-btn", "aria-label": "Close", onclick: closeModal }, "×")),
    h("div", { class: "m-body" }, body),
    foot ? h("div", { class: "m-foot" }, foot) : null);
  m.append(h("div", { class: "scrim", onclick: closeModal }), box); m.hidden = false;
  document.addEventListener("keydown", onEsc);
  const first = box.querySelector(".m-body input, .m-body select, .m-body textarea"); if (first) setTimeout(() => first.focus(), 30);
  return box;
}

/* ---------- header ---------- */
const TABS = [["compliance", "Compliance"], ["review", "Review queue"], ["signoff", "JD sign-off"], ["roster", "Staff roster"], ["jds", "Job descriptions"], ["requirements", "Requirements"], ["admins", "Users & roles"]];
const ROLES = { admin: "Admin", hr: "HR manager", head: "Department head", director: "Director" };
function renderTabs() {
  const nav = $("#tabs"); nav.replaceChildren();
  nav.hidden = !S.isAdmin; $("#stripe").hidden = S.isAdmin;
  if (!S.isAdmin) return;
  const pend = pendingQueue().length, hrPend = S.isHR ? signoffRows().filter(x => x.st.k === "hr").length : 0;
  const cnt = id => id === "review" ? pend : id === "signoff" ? hrPend : 0;
  for (const [id, label] of TABS) nav.append(h("button", { class: "tab", role: "tab", "aria-selected": String(S.tab === id), onclick: () => switchTab(id) }, label, cnt(id) ? h("span", { class: "cnt num" }, cnt(id)) : null));
}
function renderWho() {
  const w = $("#who"); w.replaceChildren();
  if (S.isAdmin || S.approver) w.append(h("div", { style: "min-width:0;text-align:right" }, h("div", { class: "w-name" }, S.myName || S.email), h("div", { class: "w-role" }, S.role === "admin" ? "Credentials office (admin)" : ROLES[S.role] + (S.approver && S.depts.length ? " · " + S.depts.map(deptName).join(", ") : ""))),
    h("button", { class: "btn sm", onclick: async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); } }, "Sign out"));
  else w.append(h("button", { class: "btn sm ghost-paper", onclick: () => adminLogin() }, "Sign in"));
}
function switchTab(id) { S.tab = id; S.built = null; try { history.replaceState(null, "", "#" + id); } catch (e) {} render(); }
function render() {
  if (!S.ready) return;
  renderTabs(); renderWho();
  if (S.approver) return renderManager();
  if (!S.isAdmin) return renderStaff();
  ({ compliance: renderCompliance, review: renderReview, signoff: renderSignoff, roster: renderRoster, jds: renderJds, requirements: renderRequirements, admins: renderAdmins }[S.tab] || renderCompliance)();
}
function setMain(...kids) { $("#main").replaceChildren(...kids.filter(Boolean)); }
const notice = (title, text) => h("div", { class: "panel empty" }, h("h2", null, title), h("p", { class: "muted" }, text));

function setupErr(e) {
  const m = (e && e.message) || "";
  if (/Database error|not been added/i.test(m)) return "This email hasn't been added to the portal. Ask an admin to add you on the Users & roles tab.";
  if (/already registered|already been registered|already exists/i.test(m)) return "This email already has a password. Use Sign in, or ask another admin to reset it.";
  if (/Signups not allowed|signup.*disabled/i.test(m)) return "Account setup is switched off in Supabase. Turn on \u201cAllow new users to sign up\u201d (Authentication \u2192 Sign In / Providers).";
  if (/confirmation email|sending/i.test(m)) return "Supabase tried to send a confirmation email. Turn off \u201cConfirm email\u201d (Authentication \u2192 Sign In / Providers \u2192 Email) and try again.";
  if (/password/i.test(m)) return m;
  return errText(e);
}
function adminLogin(mode) {
  const setup = mode === "setup";
  const email = h("input", { type: "email", id: "ad-email", autocomplete: "username", value: setup ? "" : CFG.adminEmail || "" });
  const pass = h("input", { type: "password", id: "ad-pass", autocomplete: setup ? "new-password" : "current-password" });
  const pass2 = h("input", { type: "password", id: "ad-pass2", autocomplete: "new-password" });
  const err = h("p", { class: "err", hidden: true });
  const go = h("button", { class: "btn primary" }, setup ? "Set password and sign in" : "Sign in");
  const fail = m => { err.textContent = m; err.hidden = false; };
  go.onclick = () => busy(go, async () => {
    err.hidden = true;
    const em = email.value.trim().toLowerCase();
    if (!em) return fail("Enter your email.");
    if (setup) {
      if (pass.value.length < 8) return fail("Use a password of at least 8 characters.");
      if (pass.value !== pass2.value) return fail("The two passwords don't match.");
      const up = await sb.auth.signUp({ email: em, password: pass.value });
      if (up.error) return fail(setupErr(up.error));
    }
    const res = await sb.auth.signInWithPassword({ email: em, password: pass.value });
    if (res.error) return fail(setup ? "This email already has a password. Use Sign in, or ask another admin to reset it." : errText(res.error));
    const acct = await myAccount();
    if (!acct) { await sb.auth.signOut(); return fail("This account doesn't have access to the portal. Ask an admin to add you on the Users & roles tab."); }
    closeModal(); await startSession(res.data.session, acct);
    if (setup) toast("Your account is ready");
  });
  (setup ? pass2 : pass).onkeydown = e => { if (e.key === "Enter") go.click(); };
  const swap = h("button", { class: "btn sm ghost", onclick: () => { closeModal(); adminLogin(setup ? "" : "setup"); } }, setup ? "I already have a password" : "First time? Set your password");
  openModal({ title: setup ? "Set up your account" : "Sign in",
    sub: setup ? "For people an admin has added on the Users & roles tab. Choose your own password." : "For the credentials office, HR, directors and department heads. Staff don't need to sign in.",
    body: [h("label", { class: "f", for: "ad-email" }, setup ? "Your work email" : "Email", email),
      h("label", { class: "f", for: "ad-pass" }, setup ? "New password (at least 8 characters)" : "Password", pass),
      setup ? h("label", { class: "f", for: "ad-pass2" }, "Repeat new password", pass2) : null,
      err, h("div", { class: "row" }, swap, setup ? null : h("span", { class: "hint" }, "Forgot your password? Ask another admin to reset it."))],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go] });
  setTimeout(() => (email.value ? pass : email).focus(), 40);
}

/* ---------- staff: submission form (no sign-in) ---------- */
function renderStaff() {
  if (!S.matrix) return setMain(notice("The portal isn't open yet", "The credentials office is still setting up the requirements. Check back soon."));
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Submit your credentials"),
    h("p", { class: "muted" }, "Enter your details, then upload your certificates and sign your job description. The credentials office reviews every document.")));
  const ann = announceBanner();
  if (S.finished) return setMain(head, finishedPanel());
  if (!S.person) return setMain(head, ann, detailsPanel());
  const p = S.person;
  const who = h("div", { class: "panel profile" },
    pf("Name", p.fullName), pf("Employee ID", p.employeeId), pf("Department", deptName(p.dept)), pf("Position", p.position), jobTitle(p.jobCode) ? pf("Job title", jobTitle(p.jobCode)) : null, p.designation ? pf("Designation", [p.designation, jobTitle(p.jobCode2)].filter(Boolean).join(": ")) : null,
    h("button", { class: "btn sm", onclick: () => { S.person = null; render(); } }, "Change details"));
  const req = requiredFor(p);
  const list = h("div", { class: "list" });
  if (!req.length) list.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "No credentials are set for your department and position. Contact the credentials office if this looks wrong.")));
  for (const c of req) {
    const sent = S.sent[c.id];
    list.append(h("div", { class: "cred" },
      h("div", { class: "code" }, c.short),
      h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, c.name),
        h("div", { class: "cred-meta num" }, sent ? [sent.number && "No. " + sent.number, sent.expiryDate ? "Expires " + fmtDate(sent.expiryDate) : "No expiry", sent.fileName].filter(Boolean).join(" · ")
          : c.validityMonths ? `Valid for ${c.validityMonths} months from issue` : c.expiry === "required" ? "Enter the expiry date shown on the document" : "Upload a current copy")),
      h("span", { class: "chip " + (sent ? "ok" : "neutral") }, sent ? "Submitted" : "Not added"),
      h("div", { class: "acts" }, h("button", { class: "btn sm" + (sent ? "" : " primary"), onclick: () => credModal(c) }, sent ? "Replace" : "Upload"))));
  }
  const creds = h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Required for your role"), h("span", { class: "muted" }, `${deptName(p.dept)} · ${p.position}`)),
    h("div", { class: "panel-body notice-row" }, h("p", { class: "hint" }, "Upload what's new or renewed. If the credentials office already has a current copy, you can skip it.")), list);
  const jlist = jdsFor(p);
  const jl = h("div", { class: "list" });
  for (const j of jlist) {
    const s = S.signed[j.id];
    jl.append(h("div", { class: "cred" }, h("div", { class: "code" }, "JD"),
      h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, j.title), h("div", { class: "cred-meta" }, [j.code, "Version " + j.version, s ? "Signed just now" : null].filter(Boolean).join(" · "))),
      h("span", { class: "chip " + (s ? "ok" : "warn") }, s ? "Signed" : "Signature needed"),
      h("div", { class: "acts" }, s ? h("button", { class: "btn sm ghost", onclick: () => showDoc(j.title, `Version ${j.version}`, jdBlob(j.path), j.fileName) }, "View")
        : h("button", { class: "btn sm primary", onclick: () => signModal(j) }, "Review and sign"))));
  }
  const xl = h("div", { class: "list" });
  for (const x of S.extras) xl.append(h("div", { class: "cred" }, h("div", { class: "code" }, "+"),
    h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, x.title), h("div", { class: "cred-meta num" }, [x.number && "No. " + x.number, x.expiryDate ? "Expires " + fmtDate(x.expiryDate) : null, x.fileName].filter(Boolean).join(" · "))),
    h("span", { class: "chip ok" }, "Submitted"), h("div", { class: "acts" })));
  if (!S.extras.length) xl.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "Have other certificates, for example NALS, a fellowship, a workshop or training certificate? Add them here.")));
  const extras = h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Additional certificates"), h("span", { class: "muted" }, "Optional")), xl,
    h("div", { class: "panel-body" }, h("button", { class: "btn", onclick: extraModal }, S.extras.length ? "Add another certificate" : "Add a certificate")));
  const parts = [head, ann, who, creds, extras].filter(Boolean);
  if (jlist.length) parts.push(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, jlist.length > 1 ? "Job descriptions" : "Job description"), jlist.length > 1 ? h("span", { class: "muted" }, "Sign each one") : null), jl));
  const nSent = Object.keys(S.sent).length + Object.keys(S.signed).length + S.extras.length;
  parts.push(h("div", { class: "savebar" }, h("span", { class: "grow" }, nSent ? `${nSent} item${nSent === 1 ? "" : "s"} submitted` : "Nothing submitted yet"),
    h("button", { class: "btn primary", disabled: !nSent, onclick: () => { S.finished = true; render(); window.scrollTo(0, 0); } }, "I'm finished")));
  setMain(...parts);
}
function pf(l, v) { return h("div", { class: "pf" }, h("span", { class: "pf-l" }, l), h("span", { class: "pf-v" }, v || "—")); }
function detailsPanel() {
  const m = M(), p = S.lastPerson || {};
  const f = {
    employeeId: h("input", { type: "text", id: "pf-emp", value: p.employeeId || "", inputmode: "numeric", autocomplete: "off" }),
    fullName: h("input", { type: "text", id: "pf-name", value: p.fullName || "", autocomplete: "name" }),
    dept: h("select", { id: "pf-dept" }, h("option", { value: "" }, "Choose department"), m.departments.map(d => h("option", { value: d.id }, d.name))),
    position: h("select", { id: "pf-pos" }, h("option", { value: "" }, "Choose position"), m.positions.map(x => h("option", { value: x }, x))),
    mobile: h("input", { type: "tel", id: "pf-mob", value: p.mobile || "", placeholder: "05x xxx xxxx" })
  };
  const lib = titleJds();
  if (lib.length) {
    const groups = {};
    for (const j of lib) (groups[j.category || "Other"] = groups[j.category || "Other"] || []).push(j);
    f.jobCode = h("select", { id: "pf-job" }, h("option", { value: "" }, "Choose your job title"),
      Object.keys(groups).sort().map(g => h("optgroup", { label: g }, groups[g].sort((a, b) => a.title.localeCompare(b.title)).map(j => h("option", { value: j.code }, j.title)))),
      h("option", { value: "-" }, "My job title isn't listed"));
    f.jobCode.value = p.jobCode || (p.employeeId ? "-" : "");
  }
  f.designation = h("select", { id: "pf-desig" }, h("option", { value: "" }, "None"), h("option", { value: HEAD_DESIG }, HEAD_DESIG));
  f.designation.value = p.designation || "";
  let job2Label = null;
  if (f.jobCode) {
    f.jobCode2 = f.jobCode.cloneNode(true); f.jobCode2.id = "pf-job2";
    f.jobCode2.options[0].textContent = "Choose your department head job title";
    f.jobCode2.value = p.jobCode2 || "";
    job2Label = h("label", { class: "f full", for: "pf-job2", hidden: f.designation.value !== HEAD_DESIG }, h("span", { class: "req" }, "Department head job title"), f.jobCode2,
      h("span", { class: "hint" }, "For example Head of Emergency Medicine or Head Nurse. You'll sign this job description as well as the one for your job title."));
    f.designation.onchange = () => { job2Label.hidden = f.designation.value !== HEAD_DESIG; };
  }
  f.dept.value = p.dept || ""; f.position.value = p.position || "";
  const err = h("p", { class: "err", hidden: true });
  const preview = h("p", { class: "hint" });
  const upd = () => { const req = requiredFor({ dept: f.dept.value, position: f.position.value }); preview.textContent = f.dept.value && f.position.value ? (req.length ? "You'll be asked for: " + req.map(c => c.short).join(", ") : "No credentials are set for this combination yet.") : ""; };
  f.dept.onchange = upd; f.position.onchange = upd; upd();
  const go = h("button", { class: "btn primary" }, "Continue to uploads");
  go.onclick = () => busy(go, async () => {
    const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
    const isHead = v.designation === HEAD_DESIG;
    const missing = [!v.employeeId && "employee ID", !v.fullName && "full name", !v.dept && "department", !v.position && "position", f.jobCode && !v.jobCode && "job title", f.jobCode2 && isHead && !v.jobCode2 && "department head job title"].filter(Boolean);
    if (v.jobCode === "-") v.jobCode = "";
    if (!isHead || v.jobCode2 === "-") v.jobCode2 = "";
    if (missing.length) { err.textContent = "Enter your " + missing.join(", ") + "."; err.hidden = false; return; }
    if (v.fullName.length < 2) { err.textContent = "Enter your full name."; err.hidden = false; return; }
    const ok = await sb.rpc("employee_ok", { eid: v.employeeId });
    if (ok.data === false) { err.textContent = "That employee ID isn't on the staff list. Check the number, or contact the credentials office."; err.hidden = false; return; }
    if (!S.lastPerson || S.lastPerson.employeeId !== v.employeeId) { S.sent = {}; S.signed = {}; S.extras = []; }
    S.person = v; S.lastPerson = v; render(); window.scrollTo(0, 0);
  });
  return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Your details"), h("span", { class: "muted" }, "Use your name as it appears on your SCFHS registration")),
    h("div", { class: "panel-body", style: "display:flex;flex-direction:column;gap:14px" },
      h("div", { class: "grid2" },
        h("label", { class: "f", for: "pf-emp" }, h("span", { class: "req" }, "Employee ID"), f.employeeId),
        h("label", { class: "f", for: "pf-name" }, h("span", { class: "req" }, "Full name"), f.fullName),
        h("label", { class: "f", for: "pf-dept" }, h("span", { class: "req" }, "Department"), f.dept),
        h("label", { class: "f", for: "pf-pos" }, h("span", { class: "req" }, "Position"), f.position),
        f.jobCode ? h("label", { class: "f full", for: "pf-job" }, h("span", { class: "req" }, "Job title"), f.jobCode, h("span", { class: "hint" }, "You'll be asked to read and sign the job description for this title.")) : null,
        h("label", { class: "f full", for: "pf-desig" }, "Additional designation", f.designation, h("span", { class: "hint" }, "Choose Department Head if you also lead a department.")),
        job2Label,
        h("label", { class: "f full", for: "pf-mob" }, "Mobile (optional)", f.mobile)),
      preview, err, h("div", { class: "row" }, go)));
}
function finishedPanel() {
  const items = Object.entries(S.sent).map(([id, s]) => ((M().credentials.find(c => c.id === id) || {}).short || id) + (s.fileName ? " (" + s.fileName + ")" : ""))
    .concat(S.extras.map(x => x.title + (x.fileName ? " (" + x.fileName + ")" : "")));
  const jds = Object.keys(S.signed).map(id => "Job description: " + ((S.jds.find(j => j.id === id) || {}).title || ""));
  return h("div", { class: "panel empty" }, h("h2", null, "Thank you, your documents were submitted"),
    h("p", { class: "muted" }, `Submitted for ${S.person.fullName} (employee ID ${S.person.employeeId}). The credentials office will review them and contact you if anything is missing.`),
    h("ul", { class: "done-list" }, [...items, ...jds].map(t => h("li", null, t))),
    h("p", { class: "hint" }, "You can close this page now."),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => { S.finished = false; render(); } }, "Add more documents"),
      h("button", { class: "btn ghost", onclick: () => { S.finished = false; S.person = null; S.lastPerson = null; S.sent = {}; S.signed = {}; S.extras = []; render(); } }, "Start over for someone else")));
}
const personFields = () => ({ employee_id: S.person.employeeId, full_name: S.person.fullName, dept: S.person.dept, position: S.person.position, job_code: S.person.jobCode || null, designation: S.person.designation || null, job_code2: S.person.jobCode2 || null });
// Inserts a staff record. If the database hasn't been updated with a newer column yet, retries without it so submissions still go through.
async function insertRow(table, row) {
  row = { ...row };
  let res = await sb.from(table).insert(row);
  for (let i = 0; i < 3 && res.error; i++) {
    const col = ["job_code2", "job_code", "designation"].find(c => c in row && new RegExp("\\b" + c + "\\b").test(res.error.message || ""));
    if (!col) break;
    delete row[col]; res = await sb.from(table).insert(row);
  }
  must(res);
}
const incomingDir = () => `incoming/${safeSeg(S.person.employeeId)}`;

function credModal(c) {
  const prev = S.sent[c.id] || {};
  const trackExp = c.expiry === "required" || c.validityMonths > 0;
  const isScfhs = c.id === "scfhs";
  const num = h("input", { type: "text", id: "cr-num", value: prev.number || "" });
  const cls = h("select", { id: "cr-cls" }, h("option", { value: "" }, "Choose classification"), SCFHS_CLASSES.map(x => h("option", { value: x }, x)));
  cls.value = prev.classification || "";
  const spec = h("input", { type: "text", id: "cr-spec", value: prev.specialty || "", placeholder: "Emergency Medicine" });
  const issue = h("input", { type: "date", id: "cr-issue", value: prev.issueDate || "", max: todayIso() });
  const exp = h("input", { type: "date", id: "cr-exp", value: prev.expiryDate || "" });
  const file = h("input", { type: "file", id: "cr-file", accept: "application/pdf,image/jpeg,image/png" });
  const err = h("p", { class: "err", hidden: true });
  let expTouched = !!prev.expiryDate;
  exp.oninput = () => { expTouched = true; };
  issue.onchange = () => { if (c.validityMonths && issue.value && !expTouched) exp.value = addMonths(issue.value, c.validityMonths); };
  const save = h("button", { class: "btn primary" }, "Submit");
  save.onclick = () => busy(save, async () => {
    err.hidden = true;
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (isScfhs && !num.value.trim()) return fail("Enter your SCFHS registration number.");
    if (isScfhs && !cls.value) return fail("Choose your SCFHS professional classification.");
    if (isScfhs && !spec.value.trim()) return fail("Enter the specialty shown on your SCFHS classification.");
    if (!issue.value) return fail("Enter the issue date.");
    if (trackExp && !exp.value) return fail("Enter the expiry date.");
    if (exp.value && exp.value <= issue.value) return fail("The expiry date must be after the issue date.");
    if (!file.files[0]) return fail("Attach the certificate or document.");
    let prep; try { prep = await prepareFile(file.files[0]); } catch (e) { return fail(e.message); }
    const path = await uploadTo("credentials", `${incomingDir()}/${c.id}-${rid()}.${prep.ext}`, prep.blob, prep.type);
    const rec = { cred_id: c.id, number: num.value.trim() || null, classification: isScfhs ? cls.value : null, specialty: isScfhs ? spec.value.trim() : null, issue_date: issue.value, expiry_date: exp.value || null, file_path: path, file_name: prep.name, file_type: prep.type, file_size: prep.blob.size };
    await insertRow("submissions", { ...personFields(), mobile: S.person.mobile || null, ...rec });
    S.sent[c.id] = { number: rec.number, classification: rec.classification, specialty: rec.specialty, issueDate: rec.issue_date, expiryDate: rec.expiry_date, fileName: rec.file_name };
    closeModal(); render(); toast(`${c.short} submitted`);
  });
  openModal({
    title: "Upload " + c.short, sub: c.name,
    body: [h("div", { class: "grid2" },
      h("label", { class: "f full", for: "cr-num" }, isScfhs ? h("span", { class: "req" }, "SCFHS registration number") : c.id === "cv" ? "Reference (optional)" : "Certificate / reference number", num),
      isScfhs ? h("label", { class: "f", for: "cr-cls" }, h("span", { class: "req" }, "Professional classification"), cls) : null,
      isScfhs ? h("label", { class: "f", for: "cr-spec" }, h("span", { class: "req" }, "Specialty"), spec) : null,
      h("label", { class: "f", for: "cr-issue" }, h("span", { class: "req" }, isScfhs ? "Registration date" : c.id === "cv" ? "Date last updated" : "Issue date"), issue),
      h("label", { class: "f", for: "cr-exp" }, h("span", { class: trackExp ? "req" : "" }, isScfhs ? "Registration expiry date" : trackExp ? "Expiry date" : "Expiry date (if any)"), exp,
        c.validityMonths ? h("span", { class: "hint" }, `Filled in as ${c.validityMonths} months after issue. Change it if your card says otherwise.`) : null)),
      h("div", { class: "drop" }, file, h("span", { class: "hint" }, isScfhs ? "Your SCFHS registration and classification certificate (from Mumaris+). PDF up to 5 MB, or a clear photo." : "PDF up to 5 MB, or a clear photo (JPG/PNG) of the whole certificate.")),
      prev.fileName ? h("p", { class: "hint" }, "Submitting again sends a new copy; the credentials office keeps both.") : null,
      err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), save]
  });
}

function extraModal() {
  const name = h("input", { type: "text", id: "ex-name", maxlength: "80", placeholder: "For example NALS, Fellowship certificate, Ultrasound course" });
  const num = h("input", { type: "text", id: "ex-num" });
  const issue = h("input", { type: "date", id: "ex-issue", max: todayIso() });
  const exp = h("input", { type: "date", id: "ex-exp" });
  const file = h("input", { type: "file", id: "ex-file", accept: "application/pdf,image/jpeg,image/png" });
  const err = h("p", { class: "err", hidden: true });
  const save = h("button", { class: "btn primary" }, "Submit");
  save.onclick = () => busy(save, async () => {
    err.hidden = true;
    const fail = m => { err.textContent = m; err.hidden = false; };
    const title = name.value.trim().replace(/\s+/g, " ");
    if (title.length < 2) return fail("Enter the name of the certificate.");
    if (exp.value && issue.value && exp.value <= issue.value) return fail("The expiry date must be after the issue date.");
    if (!file.files[0]) return fail("Attach the certificate.");
    let prep; try { prep = await prepareFile(file.files[0]); } catch (e) { return fail(e.message); }
    const id = rid();
    const path = await uploadTo("credentials", `${incomingDir()}/extra-${id}.${prep.ext}`, prep.blob, prep.type);
    const rec = { cred_id: EXTRA + id + ":" + title, number: num.value.trim() || null, issue_date: issue.value || null, expiry_date: exp.value || null, file_path: path, file_name: prep.name, file_type: prep.type, file_size: prep.blob.size };
    await insertRow("submissions", { ...personFields(), mobile: S.person.mobile || null, ...rec });
    S.extras.push({ title, number: rec.number, expiryDate: rec.expiry_date, fileName: rec.file_name });
    closeModal(); render(); toast(`${title} submitted`);
  });
  openModal({ title: "Add a certificate", sub: "Any certificate not listed above. The credentials office reviews it with the others.",
    body: [h("div", { class: "grid2" },
      h("label", { class: "f full", for: "ex-name" }, h("span", { class: "req" }, "Certificate name"), name),
      h("label", { class: "f full", for: "ex-num" }, "Certificate number (optional)", num),
      h("label", { class: "f", for: "ex-issue" }, "Issue date (optional)", issue),
      h("label", { class: "f", for: "ex-exp" }, "Expiry date (if any)", exp)),
      h("div", { class: "drop" }, file, h("span", { class: "hint" }, "PDF up to 5 MB, or a clear photo (JPG/PNG).")), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), save] });
}
function sigPad() {
  const c = h("canvas", { class: "sig", width: 900, height: 240, "aria-label": "Signature pad. Draw your signature." });
  const ctx = c.getContext("2d"); let down = false, has = false;
  ctx.lineWidth = 3.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0F1E17";
  const pos = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.addEventListener("pointerdown", e => { down = true; has = true; c.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + .1, y + .1); ctx.stroke(); });
  c.addEventListener("pointermove", e => { if (!down) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); });
  const up = () => { down = false; }; c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  return { el: c, has: () => has, clear() { ctx.clearRect(0, 0, c.width, c.height); has = false; }, blob: () => new Promise(r => c.toBlob(r, "image/png")) };
}
function signModal(j) {
  const view = h("div", { class: "viewer" }, h("p", { class: "muted" }, "Opening the job description…"));
  const pad = sigPad();
  const typed = h("input", { type: "text", id: "sg-name", value: S.person.fullName || "" });
  const ack = h("input", { type: "checkbox", id: "sg-ack" });
  const err = h("p", { class: "err", hidden: true });
  const sign = h("button", { class: "btn primary" }, "Sign job description");
  sign.onclick = () => busy(sign, async () => {
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (!ack.checked) return fail("Tick the acknowledgement to sign.");
    if (!typed.value.trim()) return fail("Type your full name.");
    if (!pad.has()) return fail("Draw your signature in the box.");
    const path = await uploadTo("credentials", `${incomingDir()}/signature-${j.id}-v${j.version}-${rid()}.png`, await pad.blob(), "image/png");
    await insertRow("jd_signatures", { ...personFields(), jd_id: j.id, version: j.version, typed_name: typed.value.trim(), signature_path: path });
    S.signed[j.id] = true;
    closeModal(); render(); toast("Job description signed");
  });
  openModal({
    title: j.title, sub: [j.code, "Version " + j.version].filter(Boolean).join(" · "), wide: true,
    body: [view,
      h("div", { class: "notice" }, h("label", { class: "check", for: "sg-ack" }, ack, h("span", null, "I have read this job description, understand the duties and responsibilities it sets out, and accept it as the description of my role at AlMather Hospital."))),
      h("label", { class: "f", for: "sg-name" }, "Full name", typed),
      h("div", { class: "f" }, h("span", null, "Signature"), pad.el, h("div", { class: "row" }, h("button", { class: "btn sm ghost", onclick: () => pad.clear() }, "Clear signature"), h("span", { class: "hint" }, "Sign with your mouse, finger or stylus. Date and time are recorded."))),
      err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), sign]
  });
  (async () => { try { const b = await jdBlob(j.path)(); await renderPdf(view, await b.arrayBuffer()); } catch (e) { view.replaceChildren(h("p", { class: "err" }, "The preview couldn't be shown. " + errText(e))); } })();
}

/* ---------- job description approvals (department head / director / HR) ---------- */
function chainText(sig) {
  if (!sig) return "Not signed";
  return [`Employee signed v${sig.version} on ${fmtTs(sig.signedAt)}`,
    sig.mgrSignedAt ? `${sig.mgrRole === "director" ? "Director" : "Head"}: ${sig.mgrName} on ${fmtTs(sig.mgrSignedAt)}` : null,
    sig.hrSignedAt ? `HR: ${sig.hrName} on ${fmtTs(sig.hrSignedAt)}` : null].filter(Boolean).join(" · ");
}
// Latest signature per employee and job description, current version of active JDs only.
function currentSigs(rows) {
  const by = {};
  for (const r of rows) { const k = r.employeeId.trim().toLowerCase() + "|" + r.jdId; if (!by[k] || r.signedAt > by[k].signedAt) by[k] = r; }
  return Object.values(by).map(sig => ({ sig, j: S.jds.find(j => j.id === sig.jdId) })).filter(x => x.j && !x.j.archived && x.j.version === x.sig.version);
}
async function loadQueue() { S.queue = must(await sb.rpc("manager_queue")).map(normSig); }
function sigImage(path, label) {
  const box = h("div", { class: "sigbox" }, h("span", { class: "hint" }, "Loading signature…"));
  getFile("credentials", path).then(b => box.replaceChildren(h("img", { src: URL.createObjectURL(b), alt: label }))).catch(() => box.replaceChildren(h("span", { class: "hint" }, "Signature image couldn't be loaded.")));
  return box;
}
// stage: "mgr" (head/director signs), "hr" (HR signs) or null (view only)
function approvalModal(sig, stage) {
  const j = S.jds.find(x => x.id === sig.jdId) || { title: "Job description", version: sig.version };
  const view = h("div", { class: "viewer" }, h("p", { class: "muted" }, "Opening the job description…"));
  const block = (title, name, when, path) => h("div", { class: "sigcard" }, h("div", { class: "lbl" }, title), sigImage(path, title), h("div", { class: "sub" }, `${name} · ${fmtTs(when)}`));
  const chain = h("div", { class: "sigrow" },
    block("Employee", sig.typedName, sig.signedAt, sig.path),
    sig.mgrSignedAt ? block(sig.mgrRole === "director" ? "Director" : "Department head", sig.mgrName, sig.mgrSignedAt, sig.mgrPath) : null,
    sig.hrSignedAt ? block("HR manager", sig.hrName, sig.hrSignedAt, sig.hrPath) : null);
  const body = [h("p", { class: "muted" }, `${sig.fullName} · Employee ID ${sig.employeeId} · ${deptName(sig.dept)} · ${sig.position}${sig.designation ? " · " + sig.designation : ""}`), view, h("h3", null, "Signatures"), chain];
  const foot = [h("button", { class: "btn", onclick: closeModal }, stage ? "Cancel" : "Close")];
  if (!stage) foot.unshift(h("button", { class: "btn", onclick: () => printSignedJd(sig) }, "Print signed copy"));
  if (stage) {
    const pad = sigPad();
    const typed = h("input", { type: "text", id: "ap-name", value: S.myName || "" });
    const ack = h("input", { type: "checkbox", id: "ap-ack" });
    const err = h("p", { class: "err", hidden: true });
    const go = h("button", { class: "btn primary" }, stage === "hr" ? "Sign as HR manager" : "Sign as " + mgrLabel(sig));
    go.onclick = () => busy(go, async () => {
      const fail = m => { err.textContent = m; err.hidden = false; };
      if (!ack.checked) return fail("Tick the confirmation to sign.");
      if (!typed.value.trim()) return fail("Type your full name.");
      if (!pad.has()) return fail("Draw your signature in the box.");
      const path = await uploadTo("credentials", `incoming/_approvals/${sig.id}-${stage}-${rid()}.png`, await pad.blob(), "image/png");
      must(await sb.rpc(stage === "hr" ? "jd_hr_sign" : "jd_manager_sign", { sig: sig.id, signer_name: typed.value.trim(), sig_path: path }));
      closeModal();
      if (S.approver) { await loadQueue(); render(); toast("Signed. It now goes to the HR manager."); } else await reload("Job description fully signed");
    });
    body.push(h("div", { class: "notice" }, h("label", { class: "check", for: "ap-ack" }, ack, h("span", null, stage === "hr"
        ? "I confirm, on behalf of Human Resources, that this job description has been signed by the employee and their manager and is approved as the employee's job description."
        : `I have reviewed this job description with ${sig.fullName} and confirm it accurately describes their role.`))),
      h("label", { class: "f", for: "ap-name" }, "Your full name", typed),
      h("div", { class: "f" }, h("span", null, "Your signature"), pad.el, h("div", { class: "row" }, h("button", { class: "btn sm ghost", onclick: () => pad.clear() }, "Clear signature"), h("span", { class: "hint" }, "Date and time are recorded."))), err);
    foot.push(go);
  }
  openModal({ title: j.title, sub: `Version ${sig.version}` + (j.code ? " · " + j.code : ""), body, foot, wide: true });
  (async () => { try { const b = await jdBlob(j.path)(); await renderPdf(view, await b.arrayBuffer()); } catch (e) { view.replaceChildren(h("p", { class: "err" }, "The preview couldn't be shown. " + errText(e))); } })();
}
function sigList(rows, action) {
  const list = h("div", { class: "list" });
  for (const { sig, j, st } of rows) list.append(h("div", { class: "cred" }, h("div", { class: "code" }, "JD"),
    h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, `${sig.fullName} · ${j.title}`),
      h("div", { class: "cred-meta num" }, [`ID ${sig.employeeId}`, `${deptName(sig.dept)} · ${sig.position}`, sig.designation, chainText(sig)].filter(Boolean).join(" · "))),
    h("span", { class: "chip " + (st || jdStage(sig, j)).tone }, (st || jdStage(sig, j)).label),
    h("div", { class: "acts" }, action(sig))));
  return list;
}
function renderManager() {
  const rows = currentSigs(S.queue);
  const todo = rows.filter(x => !x.sig.mgrSignedAt), done = rows.filter(x => x.sig.mgrSignedAt);
  const who = S.role === "director" ? "department heads" : "staff";
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Job descriptions to sign"),
      h("p", { class: "muted" }, `Job descriptions signed by ${who} in ${S.depts.length ? S.depts.map(deptName).join(", ") : "your departments"}. Review each one and add your signature; it then goes to the HR manager for final sign-off.`)),
    h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { await loadQueue(); render(); toast("Refreshed"); }) }, "Refresh"));
  const parts = [head];
  if (!S.depts.length) parts.push(notice("No departments assigned", "Ask an admin to set your departments on the Users & roles tab."));
  parts.push(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, todo.length ? `${todo.length} waiting for your signature` : "Nothing waiting for your signature")),
    todo.length ? sigList(todo, sig => h("button", { class: "btn sm primary", onclick: () => approvalModal(sig, "mgr") }, "Review and sign")) : h("div", { class: "empty" }, h("p", { class: "muted" }, "When someone in your department signs their job description, it appears here."))));
  if (done.length) parts.push(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Signed by you")),
    sigList(done.sort((a, b) => (b.sig.mgrSignedAt || "").localeCompare(a.sig.mgrSignedAt || "")), sig => h("button", { class: "btn sm ghost", onclick: () => approvalModal(sig, null) }, "View"))));
  setMain(...parts);
}
function signoffRows() {
  const all = [];
  for (const p of S.staff) for (const sig of Object.values(p.signatures)) all.push(sig);
  return currentSigs(all).map(x => ({ ...x, st: jdStage(x.sig, x.j) }));
}
async function renderSignoff() {
  S.built = "signoff";
  const rows = signoffRows();
  const hr = rows.filter(x => x.st.k === "hr"), mgr = rows.filter(x => x.st.k === "mgr"), done = rows.filter(x => x.st.k === "done");
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "JD sign-off"),
      h("p", { class: "muted" }, "Each job description is signed by the employee, then their department head (or a director, for department heads), then the HR manager." + (S.isHR ? "" : " Only the HR manager can give the final sign-off."))),
    h("button", { class: "btn", onclick: e => busy(e.currentTarget, () => reload("Refreshed")) }, "Refresh"));
  const mgrBox = h("div");
  setMain(head,
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, `Waiting for HR (${hr.length})`)),
      hr.length ? sigList(hr, sig => [h("button", { class: "btn sm ghost", onclick: () => approvalModal(sig, null) }, "View"), S.isHR ? h("button", { class: "btn sm primary", onclick: () => approvalModal(sig, "hr") }, "Sign") : null])
        : h("div", { class: "empty" }, h("p", { class: "muted" }, "Nothing is waiting for HR."))),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, `Waiting for department head or director (${mgr.length})`)), mgrBox),
    done.length ? h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, `Fully signed (${done.length})`)),
      sigList(done.sort((a, b) => (b.sig.hrSignedAt || "").localeCompare(a.sig.hrSignedAt || "")), sig => [h("button", { class: "btn sm ghost", onclick: () => approvalModal(sig, null) }, "View"), h("button", { class: "btn sm", onclick: () => printSignedJd(sig) }, "Print")])) : null);
  if (!mgr.length) { mgrBox.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "Nothing is waiting for a manager."))); return; }
  // Flag departments with nobody assigned to sign.
  let users = [];
  try { users = must(await sb.rpc("admin_list")) || []; } catch (e) { /* older database */ }
  const covered = (role, dept) => users.some(u => u.role === role && (u.depts || []).some(d => d === dept || d === "*"));
  mgrBox.append(sigList(mgr, sig => {
    const role = sig.designation === HEAD_DESIG ? "director" : "head";
    return [users.length && !covered(role, sig.dept) ? h("span", { class: "chip bad" }, `No ${ROLES[role].toLowerCase()} for ${deptName(sig.dept)}`) : null, h("button", { class: "btn sm ghost", onclick: () => approvalModal(sig, null) }, "View")];
  }));
}

/* ---------- admin: compliance ---------- */
function renderCompliance() {
  if (S.built !== "compliance") {
    S.built = "compliance";
    const m = M();
    const q = h("input", { type: "search", id: "cf-q", placeholder: "Search name or employee ID", value: S.f.q, oninput: e => { S.f.q = e.target.value; fillCompliance(); } });
    const dept = h("select", { id: "cf-dept", onchange: e => { S.f.dept = e.target.value; fillCompliance(); } }, h("option", { value: "" }, "All departments"), m.departments.map(d => h("option", { value: d.id }, d.name)));
    dept.value = S.f.dept;
    const st = h("select", { id: "cf-status", onchange: e => { S.f.status = e.target.value; fillCompliance(); } },
      [["", "Any status"], ["none", "Not yet submitted"], ["bad", "Action needed"], ["jd", "Signature needed"], ["pend", "Awaiting review"], ["expiring", "Expiring within 60 days"], ["ok", "Compliant"]].map(([v, l]) => h("option", { value: v }, l)));
    st.value = S.f.status;
    setMain(
      h("div", { class: "page-head" }, h("div", null, h("h1", null, "Compliance"), h("p", { class: "muted" }, "Everyone who has submitted (and everyone on the Staff roster tab) against the requirements for their department and position. Select a person to review their documents.")),
        h("div", { class: "row" }, h("button", { class: "btn", onclick: e => busy(e.currentTarget, () => reload("Refreshed")) }, "Refresh"), h("button", { class: "btn", onclick: exportCsv }, "Export CSV"), h("button", { class: "btn primary", onclick: () => adminUploadModal(null) }, "Upload document"))),
      h("div", { class: "tiles", id: "tiles" }),
      h("section", { class: "panel" }, h("div", { class: "filters" }, h("div", { class: "grow" }, q), dept, st), h("div", { id: "ctbl" })));
  }
  fillCompliance();
}
function setStatusFilter(v) { S.f.status = v; const s = $("#cf-status"); if (s) s.value = v; fillCompliance(); }
function fillCompliance() {
  const all = S.staff.map(p => ({ p, s: summarize(p) }));
  const n = fn => all.filter(fn).length;
  const comp = n(x => x.s.overall.k === "ok" && x.s.rows.length);
  const roster = n(x => x.p.onRoster);
  const tile = (l, v, s, cls, f) => h("button", { class: "tile " + cls, onclick: () => setStatusFilter(f) }, h("span", { class: "t-l" }, l), h("span", { class: "t-v" }, v), h("span", { class: "t-s" }, s));
  $("#tiles").replaceChildren(
    tile("Staff", all.length, roster ? `${roster} on roster` : "who have submitted", "", ""),
    tile("Fully compliant", comp, all.length ? Math.round(comp / all.length * 100) + "% of staff" : "—", "is-ok", "ok"),
    roster ? tile("Not yet submitted", n(x => !x.p.hasSubmitted), "on roster, nothing received", "is-bad", "none") : null,
    tile("Action needed", n(x => x.p.hasSubmitted && x.s.counts.bad), "missing, expired or returned", "is-bad", "bad"),
    tile("Expiring in 60 days", n(x => x.s.rows.some(r => r.k === "expiring")), "verified, renewal due", "is-warn", "expiring"),
    tile("Awaiting review", pendingQueue().length, "documents to check", "is-pend", "pend"),
    tile("JD signatures due", n(x => x.s.jdOut), "staff yet to sign", "is-warn", "jd"));
  const q = S.f.q.trim().toLowerCase();
  const rows = all.filter(({ p, s }) => {
    if (S.f.dept && p.dept !== S.f.dept) return false;
    if (q && !((p.fullName || "").toLowerCase().includes(q) || (p.employeeId || "").toLowerCase().includes(q))) return false;
    const f = S.f.status;
    if (f === "none" && p.hasSubmitted) return false;
    if (f === "bad" && !(p.hasSubmitted && s.counts.bad)) return false;
    if (f === "pend" && !s.counts.pend) return false;
    if (f === "jd" && !s.jdOut) return false;
    if (f === "expiring" && !s.rows.some(r => r.k === "expiring")) return false;
    if (f === "ok" && s.overall.k !== "ok") return false;
    return true;
  }).sort((a, b) => (a.p.fullName || "").localeCompare(b.p.fullName || ""));
  const box = $("#ctbl");
  if (!S.staff.length) { box.replaceChildren(h("div", { class: "empty" }, h("h3", null, "Nothing has been submitted yet"), h("p", { class: "muted" }, "Send staff the portal link. Each person enters their employee ID, name, department and position, then uploads. Their submissions appear here."))); return; }
  if (!rows.length) { box.replaceChildren(h("div", { class: "empty" }, h("p", { class: "muted" }, "Nobody matches these filters."))); return; }
  box.replaceChildren(h("div", { class: "tbl" }, h("table", null,
    h("thead", null, h("tr", null, ["Staff member", "Department · position", "Credentials", "Job description", "Status", "Last submitted"].map(t => h("th", null, t)))),
    h("tbody", null, rows.map(({ p, s }) => h("tr", { class: "click", tabindex: "0", onclick: () => staffDetail(p.uid), onkeydown: e => { if (e.key === "Enter") staffDetail(p.uid); } },
      h("td", null, h("div", { style: "font-weight:600" }, p.fullName || "—"), h("div", { class: "sub num" }, p.employeeId)),
      h("td", null, h("div", null, deptName(p.dept)), h("div", { class: "sub" }, p.position), jobTitle(p.jobCode) ? h("div", { class: "sub" }, jobTitle(p.jobCode)) : null, p.creds.scfhs && p.creds.scfhs.classification ? h("div", { class: "sub" }, "SCFHS: " + p.creds.scfhs.classification) : null),
      h("td", null, s.rows.length ? s.rows.map(r => h("span", { class: "mini " + TONE[r.k], title: `${r.c.name}: ${r.label}${r.exp ? " (expires " + fmtDate(r.exp) + ")" : ""}` }, r.c.short)) : h("span", { class: "sub" }, "None set")),
      h("td", { class: "num" }, s.jds.length ? h("span", { class: "chip " + (s.jdOut ? "warn" : "ok") }, `${s.jds.length - s.jdOut}/${s.jds.length} signed`) : h("span", { class: "sub" }, "—")),
      h("td", null, h("span", { class: "chip " + s.overall.k }, s.overall.label)),
      h("td", { class: "num sub" }, fmtTs(p.updatedAt))))))));
}
function exportCsv() {
  const esc = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["Employee ID", "Full name", "Department", "Position", "Job title", "Designation", "Mobile", "SCFHS no.", "SCFHS classification", "SCFHS specialty", "Requirement", "Status", "Certificate no.", "Issue date", "Expiry date", "Submitted"].join(",")];
  for (const p of S.staff) {
    const s = summarize(p), sc = p.creds.scfhs || {};
    const who = [p.employeeId, p.fullName, deptName(p.dept), p.position, jobTitle(p.jobCode), [p.designation, jobTitle(p.jobCode2)].filter(Boolean).join(": "), p.mobile, sc.number, sc.classification, sc.specialty];
    for (const r of extraRows(p)) lines.push([...who, "Additional: " + r.c.name, r.label, r.item.number, r.item.issueDate, r.exp, r.item.uploadedAt && r.item.uploadedAt.slice(0, 10)].map(esc).join(","));
    for (const r of s.rows) lines.push([...who, r.c.short, r.label, r.item && r.item.number, r.item && r.item.issueDate, r.exp, r.item && r.item.uploadedAt && r.item.uploadedAt.slice(0, 10)].map(esc).join(","));
    for (const x of s.jds) lines.push([...who, "JD: " + x.j.title + " v" + x.j.version, jdStage(x.sig, x.j).label, "", "", "", x.sig && x.sig.signedAt && x.sig.signedAt.slice(0, 10)].map(esc).join(","));
  }
  saveBlob(`AMH-credentials-compliance-${todayIso()}.csv`, new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
}

// Admin uploads a document on an employee's behalf: one of the defined credentials, or any document with a typed name.
function adminUploadModal(p) {
  const m = M();
  const known = () => p || S.staff.find(x => x.uid === eid.value.trim().toLowerCase()) || null;
  const eid = h("input", { type: "text", id: "au-emp", value: p ? p.employeeId : "", disabled: !!p, autocomplete: "off" });
  const name = h("input", { type: "text", id: "au-name", value: p ? p.fullName || "" : "" });
  const dept = h("select", { id: "au-dept" }, h("option", { value: "" }, "Choose department"), m.departments.map(d => h("option", { value: d.id }, d.name)));
  const pos = h("select", { id: "au-pos" }, h("option", { value: "" }, "Choose position"), m.positions.map(x => h("option", { value: x }, x)));
  dept.value = p ? p.dept || "" : ""; pos.value = p ? p.position || "" : "";
  const found = h("p", { class: "hint" });
  eid.oninput = () => { const k = known(); found.textContent = k ? `Found: ${k.fullName || "—"}, ${deptName(k.dept)} · ${k.position || "—"}` : ""; if (k) { name.value = k.fullName || name.value; dept.value = k.dept || dept.value; pos.value = k.position || pos.value; } };
  const req = p ? new Set(requiredFor(p).map(c => c.id)) : new Set();
  const doc = h("select", { id: "au-doc" }, h("option", { value: "" }, "Choose document"),
    h("optgroup", { label: "Credentials" }, m.credentials.map(c => h("option", { value: c.id }, `${c.short} · ${c.name}${req.has(c.id) ? " (required)" : ""}`))),
    h("option", { value: "@other" }, "Other document (type a name)"));
  const docName = h("input", { type: "text", id: "au-docname", maxlength: "80", placeholder: "For example Malpractice insurance, Fellowship certificate, Experience letter" });
  const nameRow = h("label", { class: "f full", for: "au-docname", hidden: true }, h("span", { class: "req" }, "Document name"), docName);
  const num = h("input", { type: "text", id: "au-num" });
  const cls = h("select", { id: "au-cls" }, h("option", { value: "" }, "Choose classification"), SCFHS_CLASSES.map(x => h("option", { value: x }, x)));
  const spec = h("input", { type: "text", id: "au-spec" });
  const scfhsRows = [h("label", { class: "f", for: "au-cls", hidden: true }, "Professional classification", cls), h("label", { class: "f", for: "au-spec", hidden: true }, "Specialty", spec)];
  const issue = h("input", { type: "date", id: "au-issue", max: todayIso() });
  const exp = h("input", { type: "date", id: "au-exp" });
  const file = h("input", { type: "file", id: "au-file", accept: "application/pdf,image/jpeg,image/png" });
  const verify = h("input", { type: "checkbox", id: "au-ver", checked: true });
  const err = h("p", { class: "err", hidden: true });
  let expTouched = false; exp.oninput = () => { expTouched = true; };
  const cred = () => m.credentials.find(c => c.id === doc.value);
  doc.onchange = () => { nameRow.hidden = doc.value !== "@other"; scfhsRows.forEach(r => r.hidden = doc.value !== "scfhs"); };
  issue.onchange = () => { const c = cred(); if (c && c.validityMonths && issue.value && !expTouched) exp.value = addMonths(issue.value, c.validityMonths); };
  const go = h("button", { class: "btn primary" }, "Upload");
  go.onclick = () => busy(go, async () => {
    err.hidden = true;
    const fail = t => { err.textContent = t; err.hidden = false; };
    const v = { eid: eid.value.trim(), name: name.value.trim(), dept: dept.value, pos: pos.value };
    if (!v.eid) return fail("Enter the employee ID.");
    if (v.name.length < 2) return fail("Enter the employee's full name.");
    if (!v.dept || !v.pos) return fail("Choose the employee's department and position.");
    if (!doc.value) return fail("Choose which document this is.");
    const title = docName.value.trim().replace(/\s+/g, " ");
    if (doc.value === "@other" && title.length < 2) return fail("Enter the document name.");
    const c = cred();
    if (c && c.expiry === "required" && !exp.value) return fail("Enter the expiry date for " + c.short + ".");
    if (exp.value && issue.value && exp.value <= issue.value) return fail("The expiry date must be after the issue date.");
    if (!file.files[0]) return fail("Attach the file.");
    let prep; try { prep = await prepareFile(file.files[0]); } catch (e) { return fail(e.message); }
    const id = rid();
    const path = await uploadTo("credentials", `incoming/${safeSeg(v.eid)}/office-${id}.${prep.ext}`, prep.blob, prep.type);
    const row = { employee_id: v.eid, full_name: v.name, dept: v.dept, position: v.pos,
      cred_id: doc.value === "@other" ? EXTRA + id + ":" + title : doc.value, number: num.value.trim() || null,
      classification: doc.value === "scfhs" ? cls.value || null : null, specialty: doc.value === "scfhs" ? spec.value.trim() || null : null,
      issue_date: issue.value || null, expiry_date: exp.value || null, file_path: path, file_name: prep.name, file_type: prep.type, file_size: prep.blob.size };
    const k = known(); if (k && k.jobCode) row.job_code = k.jobCode;
    const ins = await sb.from("submissions").insert(row).select("id").single();
    if (ins.error) throw ins.error;
    if (verify.checked) must(await sb.from("submissions").update({ status: "verified", reviewed_at: new Date().toISOString(), reviewed_by: S.email, review_note: "Uploaded by the credentials office" }).eq("id", ins.data.id));
    closeModal();
    await reload(`${title || (c && c.short) || "Document"} uploaded for ${v.name}`);
    const again = S.staff.find(x => x.uid === v.eid.toLowerCase()); if (again) staffDetail(again.uid);
  });
  openModal({ title: p ? "Upload document for " + (p.fullName || p.employeeId) : "Upload document for an employee",
    sub: "The document is added to the employee's record as if they had submitted it.",
    body: [h("div", { class: "grid2" },
        h("label", { class: "f", for: "au-emp" }, h("span", { class: "req" }, "Employee ID"), eid),
        h("label", { class: "f", for: "au-name" }, h("span", { class: "req" }, "Full name"), name),
        h("label", { class: "f", for: "au-dept" }, h("span", { class: "req" }, "Department"), dept),
        h("label", { class: "f", for: "au-pos" }, h("span", { class: "req" }, "Position"), pos)),
      p ? null : found,
      h("div", { class: "grid2" },
        h("label", { class: "f full", for: "au-doc" }, h("span", { class: "req" }, "Document"), doc), nameRow,
        h("label", { class: "f full", for: "au-num" }, "Document / certificate number (optional)", num), ...scfhsRows,
        h("label", { class: "f", for: "au-issue" }, "Issue date", issue), h("label", { class: "f", for: "au-exp" }, "Expiry date", exp)),
      h("div", { class: "drop" }, file, h("span", { class: "hint" }, "PDF up to 5 MB, or a clear photo (JPG/PNG).")),
      h("label", { class: "check", for: "au-ver" }, verify, h("span", null, "Mark as verified (you have checked it against the original)")), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go], wide: true });
}
async function setReview(item, status, note) {
  must(await sb.from("submissions").update({ status, review_note: note || null, reviewed_at: new Date().toISOString(), reviewed_by: S.email }).eq("id", item.id));
  await reload(status === "verified" ? "Marked as verified" : "Marked as returned");
}
function returnModal(r, after) {
  const note = h("textarea", { id: "rv-note", rows: "3", placeholder: "For example: certificate has expired, or the image is unreadable." });
  const go = h("button", { class: "btn primary" }, "Mark as returned");
  go.onclick = () => busy(go, async () => { if (!note.value.trim()) { note.focus(); return; } await setReview(r.item, "rejected", note.value.trim()); closeModal(); after && after(); });
  openModal({ title: "Return " + (r.c.extra ? r.c.name : r.c.short), sub: "Staff don't sign in, so contact the person with this reason and ask them to submit again.", body: h("label", { class: "f", for: "rv-note" }, "Reason", note), foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go] });
}
function reviewButtons(r, after) {
  if (!r.item) return [];
  const v = h("button", { class: "btn sm ghost", onclick: () => viewStaffFile(r.item, r.c.name) }, "View");
  const ok = h("button", { class: "btn sm" }, "Verify");
  ok.onclick = () => busy(ok, async () => { await setReview(r.item, "verified"); after && after(); });
  const no = h("button", { class: "btn sm danger", onclick: () => returnModal(r, after) }, "Return");
  return r.k === "valid" || r.k === "expiring" ? [v, no] : r.k === "rejected" ? [v, ok] : r.k === "expired" ? [v] : [v, ok, no];
}
// Rename an uploaded document: its file name, and for additional documents also the document name.
function renameModal(r, uid) {
  const item = r.item, extra = !!r.c.extra;
  const fn = item.fileName || "";
  const dot = fn.lastIndexOf("."), base = dot > 0 ? fn.slice(0, dot) : fn, ext = dot > 0 ? fn.slice(dot) : "";
  const title = h("input", { type: "text", id: "rn-title", maxlength: "80", value: extra ? r.c.name : "" });
  const file = h("input", { type: "text", id: "rn-file", maxlength: "120", value: base });
  const err = h("p", { class: "err", hidden: true });
  const go = h("button", { class: "btn primary" }, "Save");
  go.onclick = () => busy(go, async () => {
    const fail = t => { err.textContent = t; err.hidden = false; };
    const t = title.value.trim().replace(/\s+/g, " "), f = file.value.trim().replace(/[\\/:*?"<>|]+/g, "-");
    if (extra && t.length < 2) return fail("Enter the document name.");
    if (!f) return fail("Enter the file name.");
    const upd = { file_name: f + ext };
    if (extra) { const parts = item.credId.slice(EXTRA.length).split(":"); upd.cred_id = EXTRA + parts[0] + ":" + t; }
    must(await sb.from("submissions").update(upd).eq("id", item.id));
    closeModal(); await reload("Renamed"); if (uid) staffDetail(uid);
  });
  openModal({ title: "Rename document", sub: extra ? "Changes the name shown in the portal and the name of the file when downloaded." : `${r.c.name}: changes the name of the file when downloaded.`,
    body: [extra ? h("label", { class: "f", for: "rn-title" }, h("span", { class: "req" }, "Document name"), title) : null,
      h("label", { class: "f", for: "rn-file" }, h("span", { class: "req" }, "File name"), h("div", { class: "row", style: "flex-wrap:nowrap" }, file, ext ? h("span", { class: "muted" }, ext) : null)), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go] });
}
function staffDetail(uid) {
  const p = S.staff.find(x => x.uid === uid); if (!p) return;
  const s = summarize(p);
  const list = h("div", { class: "list panel" });
  for (const r of s.rows) {
    const meta = r.item ? [r.item.number && "No. " + r.item.number, credExtra(r.item), r.item.issueDate && "Issued " + fmtDate(r.item.issueDate), r.exp ? "Expires " + fmtDate(r.exp) : "No expiry", "Submitted " + fmtTs(r.item.uploadedAt), r.item.asName && r.item.asName !== p.fullName ? `as “${r.item.asName}”` : null].filter(Boolean).join(" · ") : "Nothing submitted";
    list.append(h("div", { class: "cred" }, h("div", { class: "code" }, r.c.short),
      h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, r.c.name), h("div", { class: "cred-meta num" }, meta)),
      h("span", { class: "chip " + TONE[r.k] }, r.label),
      h("div", { class: "acts" }, reviewButtons(r, () => staffDetail(uid)), r.item ? h("button", { class: "btn sm ghost", onclick: () => renameModal(r, uid) }, "Rename") : null),
      r.k === "rejected" ? h("div", { class: "cred-note" }, "Returned: " + (r.note || "")) : null));
  }
  if (!s.rows.length) list.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "No credentials are required for this department and position.")));
  const xrows = extraRows(p);
  const xlist = h("div", { class: "list panel" });
  for (const r of xrows) xlist.append(h("div", { class: "cred" }, h("div", { class: "code" }, "+"),
    h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, r.c.name), h("div", { class: "cred-meta num" }, [r.item.number && "No. " + r.item.number, r.item.issueDate && "Issued " + fmtDate(r.item.issueDate), r.exp ? "Expires " + fmtDate(r.exp) : null, "Submitted " + fmtTs(r.item.uploadedAt)].filter(Boolean).join(" · "))),
    h("span", { class: "chip " + TONE[r.k] }, r.label),
    h("div", { class: "acts" }, reviewButtons(r, () => staffDetail(uid)), h("button", { class: "btn sm ghost", onclick: () => renameModal(r, uid) }, "Rename")),
    r.k === "rejected" ? h("div", { class: "cred-note" }, "Returned: " + (r.note || "")) : null));
  const jl = h("div", { class: "list panel" });
  for (const x of s.jds) { const st = jdStage(x.sig, x.j); jl.append(h("div", { class: "cred" }, h("div", { class: "code" }, "JD"),
    h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, x.j.title), h("div", { class: "cred-meta" }, chainText(x.sig))),
    h("span", { class: "chip " + st.tone }, st.label),
    h("div", { class: "acts" }, x.sig ? h("button", { class: "btn sm ghost", onclick: () => approvalModal(x.sig, null) }, "View") : null,
      x.sig && x.sig.version === x.j.version ? h("button", { class: "btn sm", onclick: () => printSignedJd(x.sig) }, "Print") : null,
      S.isHR && st.k === "hr" ? h("button", { class: "btn sm primary", onclick: () => approvalModal(x.sig, "hr") }, "HR sign-off") : null))); }
  if (!s.jds.length) jl.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "No job description applies to this position.")));
  openModal({
    title: p.fullName || "Staff member", sub: [deptName(p.dept), p.position || "—", jobTitle(p.jobCode), p.designation, "Employee ID " + p.employeeId].filter(Boolean).join(" · "), wide: true,
    body: [h("div", { class: "row" }, h("span", { class: "chip " + s.overall.k }, s.overall.label), p.mobile ? h("span", { class: "muted num" }, p.mobile) : null, p.onRoster ? h("span", { class: "muted" }, "On staff roster") : null),
      h("h3", null, "Credentials"), list, xrows.length ? [h("h3", null, "Additional certificates"), xlist] : null, h("h3", null, "Job description"), jl],
    foot: [h("button", { class: "btn", onclick: () => adminUploadModal(p) }, "Upload document"), h("button", { class: "btn primary", onclick: closeModal }, "Done")]
  });
}

/* ---------- admin: review queue ---------- */
function renderReview() {
  S.built = "review";
  const q = pendingQueue();
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Review queue"), h("p", { class: "muted" }, "New documents, oldest first. Check each against the original and the primary source before verifying.")),
    h("button", { class: "btn", onclick: e => busy(e.currentTarget, () => reload("Refreshed")) }, "Refresh"));
  if (!q.length) return setMain(head, notice("Nothing to review", "When staff upload a document it appears here."));
  const list = h("div", { class: "list" });
  for (const r of q) list.append(h("div", { class: "cred" }, h("div", { class: "code" }, r.c.short),
    h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, `${r.p.fullName} · ${r.c.name}`),
      h("div", { class: "cred-meta num" }, [`ID ${r.p.employeeId}`, `${deptName(r.p.dept)} · ${r.p.position}`, r.item.number && "No. " + r.item.number, credExtra(r.item), r.item.issueDate && "Issued " + fmtDate(r.item.issueDate), r.exp ? "Expires " + fmtDate(r.exp) : "No expiry", "Submitted " + fmtTs(r.item.uploadedAt)].filter(Boolean).join(" · "))),
    h("span", { class: "chip pend" }, "Awaiting review"),
    h("div", { class: "acts" }, reviewButtons(r))));
  setMain(head, h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, `${q.length} document${q.length === 1 ? "" : "s"} waiting`)), list));
}

/* ---------- admin: staff roster ---------- */
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const delim = [",", ";", "\t"].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}
const ROSTER_COLS = {
  employee_id: /^(employee ?(id|no|number)|emp ?(id|no)|id|staff ?(id|no)|badge( ?no)?)$/,
  full_name: /^(full ?name|name|employee ?name|staff ?name)$/,
  dept: /^(dept|department|department ?(code|name)|unit)$/,
  position: /^(position|job ?title|title|role|designation)$/
};
const matchDept = v => { const k = v.trim().toLowerCase(); return k ? M().departments.find(d => d.id.toLowerCase() === k || d.name.toLowerCase() === k) : null; };
const matchPos = v => { const k = v.trim().toLowerCase(); return k ? M().positions.find(x => x.toLowerCase() === k) : null; };
// Turns parsed CSV rows into roster records. Unknown departments/positions are left blank (with a warning) so the person's own choice is used.
function readRoster(rows) {
  const out = [], notes = [], seen = new Set();
  if (!rows.length) return { out, notes: ["The file is empty."] };
  const norm = c => c.toLowerCase().replace(/#/g, " no").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const head = rows[0].map(norm);
  const idx = {}; for (const [k, re] of Object.entries(ROSTER_COLS)) idx[k] = head.findIndex(c => re.test(c));
  let body = rows.slice(1);
  if (idx.employee_id < 0) { body = rows; Object.assign(idx, { employee_id: 0, full_name: 1, dept: 2, position: 3 }); notes.push("No header row was recognised, so the columns were read in the order: employee ID, full name, department, position."); }
  const existing = new Map(S.roster.map(r => [r.employee_id.toLowerCase(), r.employee_id]));
  body.forEach((r, i) => {
    const line = i + (body === rows ? 1 : 2), get = k => idx[k] >= 0 ? (r[idx[k]] || "").trim() : "";
    let id = get("employee_id");
    if (!id) return notes.push(`Row ${line}: no employee ID, skipped.`);
    if (id.length > 40) return notes.push(`Row ${line}: employee ID is too long, skipped.`);
    const key = id.toLowerCase();
    if (seen.has(key)) return notes.push(`Row ${line}: employee ID ${id} appears more than once; the first row was used.`);
    seen.add(key); id = existing.get(key) || id;
    const dv = get("dept"), pv = get("position"), d = matchDept(dv), ps = matchPos(pv);
    if (dv && !d) notes.push(`Row ${line}: department “${dv}” isn't in the department list, left blank.`);
    if (pv && !ps) notes.push(`Row ${line}: position “${pv}” isn't in the position list, left blank.`);
    out.push({ employee_id: id, full_name: get("full_name") || null, dept: d ? d.id : null, position: ps || null });
  });
  return { out, notes };
}
async function saveRoster(rows, replace) {
  for (let i = 0; i < rows.length; i += 500) must(await sb.from("roster").upsert(rows.slice(i, i + 500), { onConflict: "employee_id" }));
  if (replace) {
    const keep = new Set(rows.map(r => r.employee_id.toLowerCase()));
    await deleteRoster(S.roster.filter(r => !keep.has(r.employee_id.toLowerCase())).map(r => r.employee_id));
  }
}
async function deleteRoster(ids) { for (let i = 0; i < ids.length; i += 100) must(await sb.from("roster").delete().in("employee_id", ids.slice(i, i + 100))); }
function csvLine(vals) { return vals.map(v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(","); }
function rosterTemplate() {
  const m = M(), d = m.departments[0], p = m.positions[0];
  const lines = ["employee_id,full_name,dept,position", csvLine(["100234", "Example Name", d ? d.id : "", p || ""])];
  saveBlob("AMH-staff-roster-template.csv", new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
}
function rosterExport() {
  const sub = new Set(S.staff.filter(p => p.hasSubmitted).map(p => p.uid));
  const lines = [csvLine(["employee_id", "full_name", "dept", "position", "department_name", "submitted"])];
  for (const r of S.roster) lines.push(csvLine([r.employee_id, r.full_name, r.dept, r.position, r.dept ? deptName(r.dept) : "", sub.has(r.employee_id.trim().toLowerCase()) ? "Yes" : "No"]));
  saveBlob(`AMH-staff-roster-${todayIso()}.csv`, new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
}
function renderRoster() {
  {
    S.built = "roster";
    const n = S.roster.length;
    const q = h("input", { type: "search", id: "ro-q", placeholder: "Search name or employee ID", value: S.rq, oninput: e => { S.rq = e.target.value; fillRoster(); } });
    const off = n ? armed(h("button", { class: "btn sm danger" }, "Remove everyone"), "Confirm: turn the check off", async () => {
      try { await deleteRoster(S.roster.map(r => r.employee_id)); await reload("Roster cleared. Anyone with the link can now submit."); } catch (e) { toast(errText(e), "bad"); } }) : null;
    const status = h("section", { class: "panel" }, h("div", { class: "panel-body", style: "display:flex;flex-direction:column;gap:10px" },
      h("div", { class: "row" }, h("span", { class: "chip " + (n ? "ok" : "warn") }, n ? "Roster check is on" : "Roster check is off"),
        h("span", { class: "grow" }, n ? `Only the ${n} employee ID${n === 1 ? "" : "s"} below can submit documents or sign job descriptions.` : "Anyone with the portal link can submit under any employee ID. Import your staff list to turn the check on."), off)));
    const orphans = S.staff.filter(p => p.hasSubmitted && !p.onRoster);
    if (n && orphans.length) {
      const addAll = h("button", { class: "btn sm" }, `Add ${orphans.length === 1 ? "them" : "all " + orphans.length} to the roster`);
      addAll.onclick = () => busy(addAll, async () => {
        await saveRoster(orphans.map(p => ({ employee_id: p.employeeId, full_name: p.fullName || null, dept: p.dept || null, position: p.position || null })), false);
        await reload("Added to the roster");
      });
      status.firstChild.append(h("div", { class: "row" }, h("span", { class: "chip warn" }, `${orphans.length} not on roster`),
        h("span", { class: "grow muted" }, `${orphans.length === 1 ? "One person has" : orphans.length + " people have"} already submitted under an ID that isn't on the roster. They can't submit anything more until they're added.`), addAll));
    }
    setMain(
      h("div", { class: "page-head" }, h("div", null, h("h1", null, "Staff roster"), h("p", { class: "muted" }, "The list of employee IDs allowed to submit. Staff not on it see “That employee ID isn't on the staff list” when they try. Everyone on it appears on the Compliance tab, including people who haven't submitted yet.")),
        h("div", { class: "row" }, h("button", { class: "btn", onclick: rosterTemplate }, "CSV template"), n ? h("button", { class: "btn", onclick: rosterExport }, "Export roster") : null,
          h("button", { class: "btn", onclick: () => rosterPersonModal() }, "Add person"), h("button", { class: "btn primary", onclick: rosterImportModal }, "Import CSV"))),
      status,
      h("section", { class: "panel" }, n ? h("div", { class: "filters" }, h("div", { class: "grow" }, q)) : null, h("div", { id: "rtbl" })));
  }
  fillRoster();
}
function fillRoster() {
  const box = $("#rtbl"); if (!box) return;
  if (!S.roster.length) { box.replaceChildren(h("div", { class: "empty" }, h("h3", null, "No one on the roster yet"), h("p", { class: "muted" }, "Export your staff list from HR as a CSV with the columns employee_id, full_name, dept and position, then click Import CSV. Use CSV template for an example."))); return; }
  const sub = new Set(S.staff.filter(p => p.hasSubmitted).map(p => p.uid));
  const q = S.rq.trim().toLowerCase();
  const rows = S.roster.filter(r => !q || r.employee_id.toLowerCase().includes(q) || (r.full_name || "").toLowerCase().includes(q));
  if (!rows.length) { box.replaceChildren(h("div", { class: "empty" }, h("p", { class: "muted" }, "Nobody matches this search."))); return; }
  box.replaceChildren(h("div", { class: "tbl" }, h("table", null,
    h("thead", null, h("tr", null, ["Staff member", "Department · position", "Submitted", ""].map(t => h("th", null, t)))),
    h("tbody", null, rows.map(r => {
      const rm = armed(h("button", { class: "btn sm danger" }, "Remove"), "Confirm remove", async () => { try { await deleteRoster([r.employee_id]); await reload(`${r.employee_id} removed from the roster`); } catch (e) { toast(errText(e), "bad"); } });
      return h("tr", null,
        h("td", null, h("div", { style: "font-weight:600" }, r.full_name || "—"), h("div", { class: "sub num" }, r.employee_id)),
        h("td", null, h("div", null, r.dept ? deptName(r.dept) : "—"), h("div", { class: "sub" }, r.position || "")),
        h("td", null, sub.has(r.employee_id.trim().toLowerCase()) ? h("span", { class: "chip ok" }, "Yes") : h("span", { class: "chip neutral" }, "Not yet")),
        h("td", null, h("div", { class: "acts" }, h("button", { class: "btn sm", onclick: () => rosterPersonModal(r) }, "Edit"), rm)));
    })))));
}
function rosterPersonModal(r) {
  const m = M();
  const id = h("input", { type: "text", id: "ro-id", value: r ? r.employee_id : "", disabled: !!r, autocomplete: "off" });
  const name = h("input", { type: "text", id: "ro-name", value: r ? r.full_name || "" : "" });
  const dept = h("select", { id: "ro-dept" }, h("option", { value: "" }, "Not set"), m.departments.map(d => h("option", { value: d.id }, d.name)));
  const pos = h("select", { id: "ro-pos" }, h("option", { value: "" }, "Not set"), m.positions.map(x => h("option", { value: x }, x)));
  dept.value = r && r.dept || ""; pos.value = r && r.position || "";
  const err = h("p", { class: "err", hidden: true });
  const go = h("button", { class: "btn primary" }, r ? "Save" : "Add to roster");
  go.onclick = () => busy(go, async () => {
    const eid = id.value.trim();
    if (!eid) { err.textContent = "Enter the employee ID."; err.hidden = false; return; }
    if (eid.length > 40) { err.textContent = "That employee ID is too long."; err.hidden = false; return; }
    const same = S.roster.find(x => x.employee_id.toLowerCase() === eid.toLowerCase());
    if (!r && same) { err.textContent = `${same.employee_id} is already on the roster${same.full_name ? " (" + same.full_name + ")" : ""}.`; err.hidden = false; return; }
    must(await sb.from("roster").upsert({ employee_id: r ? r.employee_id : eid, full_name: name.value.trim() || null, dept: dept.value || null, position: pos.value || null }, { onConflict: "employee_id" }));
    closeModal(); await reload(r ? "Saved" : `${eid} added to the roster`);
  });
  openModal({ title: r ? "Edit roster entry" : "Add person to roster", sub: r ? "To change an employee ID, remove this entry and add a new one." : "This person will be able to submit straight away.",
    body: [h("div", { class: "grid2" }, h("label", { class: "f", for: "ro-id" }, h("span", { class: "req" }, "Employee ID"), id), h("label", { class: "f", for: "ro-name" }, "Full name", name),
      h("label", { class: "f", for: "ro-dept" }, "Department", dept), h("label", { class: "f", for: "ro-pos" }, "Position", pos)),
      h("p", { class: "hint" }, "Department and position on the roster take priority over what the person selects on the form, so their requirements always follow the roster."), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go] });
}
function rosterImportModal() {
  const file = h("input", { type: "file", id: "ro-file", accept: ".csv,text/csv" });
  const merge = h("input", { type: "radio", name: "ro-mode", value: "merge", checked: true });
  const repl = h("input", { type: "radio", name: "ro-mode", value: "replace" });
  const summary = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const go = h("button", { class: "btn primary", disabled: true }, "Import");
  let parsed = null;
  const show = () => {
    if (!parsed) { summary.replaceChildren(); go.disabled = true; return; }
    const { out, notes } = parsed;
    const ex = new Map(S.roster.map(r => [r.employee_id.toLowerCase(), r]));
    const fresh = out.filter(r => !ex.has(r.employee_id.toLowerCase())).length;
    const keep = new Set(out.map(r => r.employee_id.toLowerCase()));
    const gone = repl.checked ? S.roster.filter(r => !keep.has(r.employee_id.toLowerCase())).length : 0;
    const parts = [`${out.length} ${out.length === 1 ? "person" : "people"} in the file`, `${fresh} new`, `${out.length - fresh} already on the roster (details updated)`];
    if (gone) parts.push(`${gone} removed because they aren't in the file`);
    summary.replaceChildren(h("p", null, h("strong", null, parts.join(" · "))),
      notes.length ? h("div", { class: "notice" }, h("p", { class: "hint" }, `${notes.length} note${notes.length === 1 ? "" : "s"}:`), h("ul", { class: "done-list" }, notes.slice(0, 12).map(t => h("li", null, t))), notes.length > 12 ? h("p", { class: "hint" }, `…and ${notes.length - 12} more.`) : null) : null);
    go.disabled = !out.length;
    go.textContent = out.length ? `Import ${out.length}` : "Import";
  };
  file.onchange = async () => {
    parsed = null; show();
    const f = file.files[0]; if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) { summary.replaceChildren(h("p", { class: "err" }, "That's an Excel file. In Excel use File → Save As → CSV UTF-8, then choose the .csv file.")); return; }
    try { parsed = readRoster(parseCsv(await f.text())); } catch (e) { summary.replaceChildren(h("p", { class: "err" }, "The file couldn't be read. " + errText(e))); return; }
    show();
  };
  merge.onchange = show; repl.onchange = show;
  go.onclick = () => busy(go, async () => {
    await saveRoster(parsed.out, repl.checked);
    closeModal(); await reload(`Roster imported: ${parsed.out.length} ${parsed.out.length === 1 ? "person" : "people"}`);
  });
  openModal({ title: "Import staff roster", sub: "A CSV with the columns employee_id, full_name, dept and position. Department can be the name or the code.",
    body: [h("div", { class: "drop" }, file, h("span", { class: "hint" }, "Save from Excel as “CSV UTF-8”. Only the employee ID column is required.")),
      h("div", { class: "f" }, h("span", null, "How to import"), h("div", { class: "checks", style: "flex-direction:column;align-items:flex-start" },
        h("label", { class: "check" }, merge, "Add new people and update existing ones"),
        h("label", { class: "check" }, repl, "Replace the roster: remove anyone who isn't in this file"))),
      summary],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go], wide: true });
}

/* ---------- admin: users & roles ---------- */
const ROLE_HELP = { admin: "Full access to everything.", hr: "Full access, plus the final signature on every job description.",
  head: "Signs the job descriptions of staff in their departments. Sees nothing else.", director: "Signs the job descriptions of department heads in their departments. Sees nothing else." };
async function renderAdmins() {
  S.built = "admins";
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Users & roles"), h("p", { class: "muted" }, "People who can sign in. Admins and the HR manager have full access; department heads and directors only sign job descriptions for their departments.")),
    h("button", { class: "btn primary", onclick: () => userModal() }, "Add user"));
  const box = h("section", { class: "panel" }, h("div", { class: "empty" }, h("p", { class: "muted" }, "Loading…")));
  setMain(head, box);
  const res = await sb.rpc("admin_list");
  if (S.tab !== "admins") return;
  if (res.error) { box.replaceChildren(h("div", { class: "empty" }, h("h3", null, "The user list couldn't load"), h("p", { class: "muted" }, /admin_list|function|column/i.test(res.error.message || "") ? "The database needs updating: run supabase/schema.sql again in the Supabase SQL Editor, then refresh." : errText(res.error)))); return; }
  const me = S.email.toLowerCase();
  const order = { hr: 0, admin: 1, director: 2, head: 3 };
  const list = h("div", { class: "list" });
  for (const a of (res.data || []).sort((x, y) => (order[x.role] ?? 9) - (order[y.role] ?? 9) || x.email.localeCompare(y.email))) {
    const self = a.email.toLowerCase() === me;
    const role = a.role || "admin";
    const state = !a.has_account ? ["warn", "Invited, hasn't set a password"] : a.last_sign_in_at ? ["ok", "Last signed in " + fmtTs(a.last_sign_in_at)] : ["neutral", "Password set, not signed in yet"];
    const act = (fn, msg) => async () => { try { must(await sb.rpc(fn, { target: a.email })); toast(msg); renderAdmins(); } catch (e) { toast(errText(e), "bad"); } };
    list.append(h("div", { class: "cred" }, h("div", { class: "code" }, (a.full_name || a.email)[0].toUpperCase()),
      h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, a.full_name || a.email, self ? h("span", { class: "muted" }, " (you)") : null),
        h("div", { class: "cred-meta" }, [a.full_name ? a.email : null, ROLES[role] + ((role === "head" || role === "director") ? ": " + ((a.depts || []).map(deptName).join(", ") || "no departments set") : ""), a.added_by ? "Added by " + a.added_by : null].filter(Boolean).join(" · "))),
      h("span", { class: "chip " + state[0] }, state[1]),
      h("div", { class: "acts" }, h("button", { class: "btn sm", onclick: () => userModal(a) }, "Edit"), self ? null : [
        a.has_account ? armed(h("button", { class: "btn sm" }, "Reset password"), "Confirm reset", act("admin_reset", `Password reset. ${a.email} can now choose a new one with \u201cFirst time? Set your password\u201d.`)) : h("button", { class: "btn sm", onclick: () => inviteText(a.email) }, "Instructions"),
        armed(h("button", { class: "btn sm danger" }, "Remove"), "Confirm remove", act("admin_remove", `${a.email} can no longer sign in`))])));
  }
  box.replaceChildren(list, h("div", { class: "panel-body notice-row" }, h("p", { class: "hint" }, "Reset password removes the person's current password; they then set a new one from the sign-in screen. You can't reset or remove your own account.")));
}
function inviteText(em) {
  const url = location.origin + location.pathname;
  const msg = `You've been added to the AMH Staff Credentials Portal.\n\n1. Open ${url}\n2. Click \u201cSign in\u201d, then \u201cFirst time? Set your password\u201d.\n3. Enter ${em} and choose your password.`;
  const ta = h("textarea", { rows: "6", readonly: true }, msg);
  const copy = h("button", { class: "btn primary" }, "Copy message");
  copy.onclick = async () => { try { await navigator.clipboard.writeText(msg); toast("Copied"); } catch (e) { ta.select(); toast("Select the text and copy it", "bad"); } };
  openModal({ title: "Send this to " + em, sub: "No email is sent automatically.", body: ta, foot: [h("button", { class: "btn", onclick: closeModal }, "Done"), copy] });
}
function userModal(a) {
  const email = h("input", { type: "email", id: "na-email", placeholder: "name@kfshrc.edu.sa", value: a ? a.email : "", disabled: !!a });
  const name = h("input", { type: "text", id: "na-name", value: a ? a.full_name || "" : "" });
  const role = h("select", { id: "na-role" }, Object.entries(ROLES).map(([v, l]) => h("option", { value: v }, l)));
  role.value = a ? a.role || "admin" : "admin";
  const help = h("p", { class: "hint" });
  const cur = new Set(a ? a.depts || [] : []);
  const depts = [["*", "All departments"], ...M().departments.map(d => [d.id, d.name])].map(([v, l]) => { const cb = h("input", { type: "checkbox", value: v, checked: cur.has(v) }); return { v, cb, el: h("label", { class: "check" }, cb, l) }; });
  const deptBox = h("div", { class: "f" }, h("span", { class: "req" }, "Departments"), h("div", { class: "checks" }, depts.map(d => d.el)));
  const upd = () => { help.textContent = ROLE_HELP[role.value]; deptBox.hidden = !(role.value === "head" || role.value === "director"); };
  role.onchange = upd; upd();
  const err = h("p", { class: "err", hidden: true });
  const go = h("button", { class: "btn primary" }, a ? "Save" : "Add user");
  go.onclick = () => busy(go, async () => {
    const fail = m => { err.textContent = m; err.hidden = false; };
    const em = email.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return fail("Enter a valid email address.");
    const scoped = role.value === "head" || role.value === "director";
    const ds = scoped ? depts.filter(d => d.cb.checked).map(d => d.v) : [];
    if (scoped && !ds.length) return fail("Choose at least one department.");
    const args = { new_name: name.value.trim(), new_role: role.value, new_depts: ds };
    must(a ? await sb.rpc("admin_update", { target: a.email, ...args }) : await sb.rpc("admin_add", { new_email: em, ...args }));
    closeModal(); await renderAdmins();
    if (a) toast("Saved"); else inviteText(em);
  });
  openModal({ title: a ? "Edit " + (a.full_name || a.email) : "Add user", sub: a ? a.email : "They'll set their own password from the sign-in screen.",
    body: [h("div", { class: "grid2" }, h("label", { class: "f", for: "na-email" }, "Work email", email), h("label", { class: "f", for: "na-name" }, "Full name", name),
      h("label", { class: "f full", for: "na-role" }, "Role", role, help)), deptBox,
      h("p", { class: "hint" }, "Department head: signs for staff in the departments ticked. Director: signs for the department heads of the departments ticked (for example the CMO for medical departments, the Nursing Director for nursing units)."), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go], wide: true });
}

function audienceText(j) { if (j.dept === TITLE_JD) return `${j.category ? j.category + " · " : ""}staff who choose this job title`; return `${deptName(j.dept)} · ${j.positions && j.positions.length ? j.positions.join(", ") : "all positions"}`; }
function renderJds() {
  S.built = "jds";
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Job descriptions"), h("p", { class: "muted" }, "Library job descriptions are chosen by staff through the Job title field on the form; others apply to a department and position. Staff read and sign the one that applies to them. A new version must be signed again.")),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: jdImportModal }, "Import JD library"), h("button", { class: "btn primary", onclick: () => jdModal() }, "Upload job description")));
  const all = S.jds.filter(j => !j.archived).sort((a, b) => (a.code || "~").localeCompare(b.code || "~") || a.title.localeCompare(b.title));
  if (!all.length) return setMain(head, notice("No job descriptions issued", "Click Import JD library to load the AMH job description library in one step, or upload a single job description and assign it to a department and position."));
  const q = (S.jq || "").trim().toLowerCase();
  const active = all.filter(j => !q || [j.title, j.code, j.category].some(x => (x || "").toLowerCase().includes(q)));
  const search = h("input", { type: "search", id: "jd-q", placeholder: "Search title, code or department", value: S.jq || "", oninput: e => { S.jq = e.target.value; const pos = e.target.selectionStart; renderJds(); const n = $("#jd-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } } });
  const list = h("div", { class: "list" });
  if (!active.length) list.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "No job descriptions match this search.")));
  for (const j of active) {
    const people = S.staff.filter(p => jdsFor(p).some(x => x.id === j.id));
    const signed = people.filter(p => p.signatures[j.id] && p.signatures[j.id].version === j.version).length;
    const arch = armed(h("button", { class: "btn sm danger" }, "Withdraw"), "Confirm withdraw", async () => { try { must(await sb.from("job_descriptions").update({ archived: true, updated_at: new Date().toISOString() }).eq("id", j.id)); await reload("Job description withdrawn"); } catch (e) { toast(errText(e), "bad"); } });
    list.append(h("div", { class: "cred" }, h("div", { class: "code" }, "v" + j.version),
      h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, j.title), h("div", { class: "cred-meta" }, [j.code, audienceText(j), "Issued " + fmtTs(j.updatedAt)].filter(Boolean).join(" · "))),
      h("span", { class: "chip " + (people.length && signed === people.length ? "ok" : people.length ? "warn" : "neutral") }, `${signed}/${people.length} signed`),
      h("div", { class: "acts" },
        h("button", { class: "btn sm ghost", onclick: () => showDoc(j.title, `Version ${j.version}`, jdBlob(j.path), j.fileName) }, "View"),
        h("button", { class: "btn sm", onclick: () => jdSignatures(j) }, "Signatures"),
        h("button", { class: "btn sm", onclick: () => jdModal(j) }, "New version"), arch)));
  }
  setMain(head, h("section", { class: "panel" }, h("div", { class: "filters" }, h("div", { class: "grow" }, search), h("span", { class: "muted" }, `${active.length} of ${all.length}`)), list));
}
function b64Blob(b64, type) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); }
// Imports the AMH job description library. By default it loads the PDFs published with the portal (jd-library/);
// an exported library file (AMH-JD-Library-import.json) can be chosen instead.
function jdImportModal() {
  const summary = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const go = h("button", { class: "btn primary", disabled: true }, "Checking the library…");
  const file = h("input", { type: "file", id: "jdi-file", accept: ".json,application/json" });
  let todo = [], getPdf = null;
  const prepare = (lib, loader) => {
    todo = []; getPdf = loader; summary.replaceChildren();
    if (!lib || lib.format !== "amh-jd-library" || !Array.isArray(lib.items)) { summary.append(h("p", { class: "err" }, "That isn't a job description library file.")); go.disabled = true; go.textContent = "Import"; return; }
    const have = new Set(S.jds.filter(j => !j.archived && j.code).map(j => j.code.toLowerCase()));
    todo = lib.items.filter(x => x.code && x.title && !have.has(x.code.toLowerCase()));
    const skip = lib.items.length - todo.length;
    summary.append(h("p", null, h("strong", null, `${lib.items.length} job descriptions in the AMH library · ${todo.length} to import${skip ? ` · ${skip} already in the portal (skipped)` : ""}`)),
      h("p", { class: "hint" }, "Each one is issued as version 1. Staff choose their job title on the form and are asked to sign that job description."));
    go.disabled = !todo.length; go.textContent = todo.length ? `Import ${todo.length}` : "Nothing new to import";
  };
  (async () => {
    // The library is published with the portal; if a network filter blocks it, try the same files via jsDelivr and GitHub.
    const sources = CFG.jdLibrarySources || ["jd-library/", "https://cdn.jsdelivr.net/gh/MahaElalfy/AMH-Staff-Credentials@main/jd-library/", "https://raw.githubusercontent.com/MahaElalfy/AMH-Staff-Credentials/main/jd-library/"];
    const fails = [];
    for (const base of sources) {
      try {
        const r = await fetch(base + "index.json", { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const lib = await r.json();
        prepare(lib, async x => { const p = await fetch(base + encodeURIComponent(x.file)); if (!p.ok) throw new Error(`HTTP ${p.status} from ${base}`); return await p.blob(); });
        if (base !== sources[0]) summary.append(h("p", { class: "hint" }, "Loaded from " + new URL(base, location.href).host + " because the portal's own copy was blocked on this network."));
        return;
      } catch (e) { fails.push(`${new URL(base, location.href).href}: ${e.message || e}`); }
    }
    summary.replaceChildren(h("p", { class: "err" }, "The built-in library couldn't be loaded on this network. Choose the library file below instead, or send these details to whoever set up the portal:"),
      h("ul", { class: "done-list hint" }, fails.map(t => h("li", null, t))));
    go.textContent = "Import";
  })();
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    let lib; try { lib = JSON.parse(await f.text()); } catch (e) { summary.replaceChildren(h("p", { class: "err" }, "That file couldn't be read.")); return; }
    prepare(lib, async x => { if (!x.pdf) throw new Error(`${x.code} has no PDF in the file.`); return b64Blob(x.pdf, "application/pdf"); });
  };
  go.onclick = () => busy(go, async () => { try { await runImport(); } catch (e) { summary.append(h("p", { class: "err" }, errText(e))); throw e; } });
  const runImport = async () => {
    let done = 0;
    const bar = h("p", { class: "hint", role: "status" });
    summary.append(bar);
    for (const x of todo) {
      bar.textContent = `Importing ${done + 1} of ${todo.length}: ${x.title}…`;
      const step = async (what, fn) => { try { return await fn(); } catch (e) { const m = (e && (e.message || e.error_description || e.error)) || String(e); throw new Error(`Stopped at ${x.code} (${x.title}) while ${what}: ${m}${done ? `. ${done} were imported; run the import again to continue.` : ""}`); } };
      const blob = await step("loading the PDF", () => getPdf(x));
      const path = await step("uploading the PDF to storage", () => uploadTo("jds", `${rid()}.pdf`, new Blob([blob], { type: "application/pdf" }), "application/pdf"));
      const res = await sb.from("job_descriptions").insert({ title: x.title, code: x.code, category: x.category || null, dept: TITLE_JD, positions: [], file_path: path, file_name: x.file_name || x.code + ".pdf", version: 1 });
      if (res.error && /category/.test(res.error.message || "")) throw new Error("The database needs updating first: run supabase/schema.sql again in the Supabase SQL Editor, then import again. Nothing already imported will be duplicated.");
      await step("saving the job description", async () => must(res)); done++;
    }
    closeModal(); await reload(`${done} job descriptions imported`);
  };
  openModal({ title: "Import AMH job description library", sub: "Loads the job descriptions from the AMH Job Description Library in one step. Keep this page open until it finishes.",
    body: [summary, h("details", null, h("summary", { class: "hint" }, "Use a library file instead"), h("div", { class: "drop", style: "margin-top:8px" }, file, h("span", { class: "hint" }, "Only needed for a library file sent to you separately (AMH-JD-Library-import.json)."))) ],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go], wide: true });
}
function jdModal(j) {
  const m = M();
  const title = h("input", { type: "text", id: "jd-title", value: j ? j.title : "", placeholder: "Consultant, Emergency Medicine" });
  const code = h("input", { type: "text", id: "jd-code", value: j ? j.code || "" : "", placeholder: "JD-EM-001" });
  const dept = h("select", { id: "jd-dept" }, h("option", { value: "*" }, "All departments"), m.departments.map(d => h("option", { value: d.id }, d.name)));
  dept.value = j ? j.dept : "*";
  const pos = m.positions.map(x => { const cb = h("input", { type: "checkbox", value: x, checked: !!(j && j.positions.includes(x)) }); return { x, cb, el: h("label", { class: "check" }, cb, x) }; });
  const file = h("input", { type: "file", id: "jd-file", accept: "application/pdf" });
  const err = h("p", { class: "err", hidden: true });
  const go = h("button", { class: "btn primary" }, j ? "Issue new version" : "Issue job description");
  go.onclick = () => busy(go, async () => {
    const fail = s => { err.textContent = s; err.hidden = false; };
    if (!title.value.trim()) return fail("Give the job description a title.");
    const f = file.files[0];
    if (!f) return fail("Attach the job description PDF.");
    if (!(f.type === "application/pdf" || /\.pdf$/i.test(f.name))) return fail("Job descriptions must be PDF files.");
    if (f.size > 20 * 1048576) return fail("The PDF must be under 20 MB.");
    const path = await uploadTo("jds", `${rid()}.pdf`, f, "application/pdf");
    const now = new Date().toISOString();
    const lib = j && j.dept === TITLE_JD;
    const body = { title: title.value.trim(), code: code.value.trim() || null, dept: lib ? TITLE_JD : dept.value, positions: lib ? [] : pos.filter(p => p.cb.checked).map(p => p.x), file_path: path, file_name: f.name, updated_at: now };
    if (j) {
      const hist = (j.history || []).concat([{ version: j.version, file_path: j.path, file_name: j.fileName, issued_at: j.updatedAt }]);
      must(await sb.from("job_descriptions").update({ ...body, version: j.version + 1, history: hist }).eq("id", j.id));
    } else must(await sb.from("job_descriptions").insert({ ...body, version: 1 }));
    closeModal(); await reload(j ? `Version ${j.version + 1} issued` : "Job description issued");
  });
  openModal({
    title: j ? "New version of " + j.title : "Upload job description", sub: j ? `Staff who signed version ${j.version} will be asked to sign again.` : "Staff matching the department and positions below will be asked to sign it.",
    body: [h("div", { class: "grid2" }, h("label", { class: "f full", for: "jd-title" }, "Title", title), h("label", { class: "f", for: "jd-code" }, "Document code", code), j && j.dept === TITLE_JD ? null : h("label", { class: "f", for: "jd-dept" }, "Department", dept)),
      j && j.dept === TITLE_JD ? h("p", { class: "hint" }, "Staff who chose this job title will be asked to sign the new version.") : h("div", { class: "f" }, h("span", null, "Positions"), h("div", { class: "checks" }, pos.map(p => p.el)), h("span", { class: "hint" }, "Leave all unticked to include every position in the department.")),
      h("div", { class: "drop" }, file, h("span", { class: "hint" }, "PDF, up to 20 MB.")), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go]
  });
}
function jdSignatures(j) {
  const people = S.staff.filter(p => jdsFor(p).some(x => x.id === j.id)).sort((a, b) => (a.fullName || "").localeCompare(b.fullName || ""));
  const body = people.length ? h("div", { class: "tbl" }, h("table", null, h("thead", null, h("tr", null, ["Staff member", "Position", "Status", ""].map(t => h("th", null, t)))),
    h("tbody", null, people.map(p => { const s = p.signatures[j.id]; const st = jdStage(s, j);
      return h("tr", null, h("td", null, h("div", { style: "font-weight:600" }, p.fullName), h("div", { class: "sub num" }, p.employeeId)), h("td", null, deptName(p.dept), h("div", { class: "sub" }, p.position)),
        h("td", null, h("span", { class: "chip " + st.tone }, st.label), s ? h("div", { class: "sub" }, chainText(s)) : null),
        h("td", null, s ? h("button", { class: "btn sm ghost", onclick: () => approvalModal(s, null) }, "View") : null)); }))))
    : h("p", { class: "muted" }, "No staff match this job description yet.");
  openModal({ title: "Signatures", sub: `${j.title} · version ${j.version} · ${audienceText(j)}`, wide: true, body, foot: [h("button", { class: "btn primary", onclick: closeModal }, "Done")] });
}

/* ---------- admin: requirements matrix ---------- */
function renderRequirements() {
  if (S.built !== "requirements") { S.built = "requirements"; S.dirty = false; }
  if (S.dirty) return;
  S.draft = clone(S.matrix || { credentials: [], departments: [], positions: [], rules: [] });
  buildRequirements();
}
function touch(rebuild) { S.dirty = true; if (rebuild) buildRequirements(); else { fillPreview(); const b = $("#savebar"); if (b) b.hidden = false; } }
function buildRequirements() {
  const m = S.draft;
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Requirements"), h("p", { class: "muted" }, "Define the credentials staff can be asked for, then rules that say which department and position needs which. A person needs everything from every rule that matches them.")));
  const credRows = m.credentials.map((c, i) => {
    const short = h("input", { type: "text", value: c.short, "aria-label": "Short code", oninput: e => { c.short = e.target.value.trim(); touch(); } });
    const name = h("input", { type: "text", value: c.name, "aria-label": "Full name", class: "wide2", oninput: e => { c.name = e.target.value; touch(); } });
    const val = h("input", { type: "number", min: "0", max: "120", value: String(c.validityMonths || 0), "aria-label": "Validity in months", oninput: e => { c.validityMonths = Math.max(0, parseInt(e.target.value, 10) || 0); touch(); } });
    const ex = h("select", { "aria-label": "Expiry", onchange: e => { c.expiry = e.target.value; touch(); } }, h("option", { value: "required" }, "Has expiry"), h("option", { value: "none" }, "No expiry"));
    ex.value = c.expiry || "none";
    const del = armed(h("button", { class: "icon-btn", "aria-label": "Remove " + c.short, title: "Remove" }, "×"), "?", () => { m.credentials.splice(i, 1); m.rules.forEach(r => r.creds = r.creds.filter(x => x !== c.id)); touch(true); });
    return h("div", { class: "edit-row" }, short, name, val, ex, del);
  });
  const creds = h("section", { class: "panel req-sec" }, h("div", { class: "panel-head" }, h("h2", null, "Credentials"), h("button", { class: "btn sm", onclick: () => { m.credentials.push({ id: rid(), short: "NEW", name: "New credential", validityMonths: 24, expiry: "required" }); touch(true); } }, "Add credential")),
    h("div", { class: "panel-body" }, h("div", { class: "edit-row edit-head" }, h("span", null, "Code"), h("span", null, "Full name"), h("span", null, "Valid (months)"), h("span", null, "Expiry"), h("span", null, "")), credRows,
      h("p", { class: "hint" }, "Validity pre-fills the expiry date from the issue date; staff can correct it. Set 0 when the document carries its own expiry date (for example the SCFHS registration).")));
  const tagEditor = (items, label, onAdd, onRemove, toText) => {
    const inp = h("input", { type: "text", placeholder: "Add " + label.toLowerCase(), "aria-label": "Add " + label.toLowerCase() });
    const add = () => { const v = inp.value.trim(); if (!v) return; if (onAdd(v)) touch(true); };
    inp.onkeydown = e => { if (e.key === "Enter") add(); };
    return h("section", { class: "panel req-sec" }, h("div", { class: "panel-head" }, h("h2", null, label)),
      h("div", { class: "panel-body" }, h("div", { class: "tagset" }, items.map((it, i) => h("span", { class: "tag" }, toText(it), h("button", { "aria-label": "Remove " + toText(it), onclick: () => { if (onRemove(it, i)) touch(true); } }, "×")))),
        h("div", { class: "row" }, h("div", { style: "flex:1;min-width:180px" }, inp), h("button", { class: "btn sm", onclick: add }, "Add"))));
  };
  const depts = tagEditor(m.departments, "Departments",
    v => { if (m.departments.some(d => d.name.toLowerCase() === v.toLowerCase())) return false; m.departments.push({ id: rid(), name: v }); return true; },
    (d, i) => { if (m.rules.some(r => r.dept === d.id)) { toast("A rule uses this department. Change or delete that rule first.", "bad"); return false; } m.departments.splice(i, 1); return true; }, d => d.name);
  const posns = tagEditor(m.positions, "Positions",
    v => { if (m.positions.includes(v)) return false; m.positions.push(v); return true; },
    (x, i) => { m.positions.splice(i, 1); m.rules.forEach(r => r.positions = (r.positions || []).filter(p => p !== x)); return true; }, x => x);
  const rules = m.rules.map((r, i) => {
    const dept = h("select", { "aria-label": "Department", onchange: e => { r.dept = e.target.value; touch(); } }, h("option", { value: "*" }, "All departments"), m.departments.map(d => h("option", { value: d.id }, d.name)));
    dept.value = r.dept;
    const del = armed(h("button", { class: "btn sm danger" }, "Delete rule"), "Confirm delete", () => { m.rules.splice(i, 1); touch(true); });
    return h("div", { class: "rule" }, h("div", { class: "rule-top" }, h("span", { class: "lbl" }, "When department is"), dept, h("span", { style: "margin-left:auto" }, del)),
      h("div", null, h("div", { class: "lbl" }, "and position is (none ticked = any position)"), h("div", { class: "checks" }, m.positions.map(x => h("label", { class: "check" }, h("input", { type: "checkbox", checked: (r.positions || []).includes(x), onchange: e => { r.positions = e.target.checked ? [...(r.positions || []), x] : r.positions.filter(p => p !== x); touch(); } }), x)))),
      h("div", null, h("div", { class: "lbl" }, "require"), h("div", { class: "checks" }, m.credentials.map(c => h("label", { class: "check" }, h("input", { type: "checkbox", checked: r.creds.includes(c.id), onchange: e => { r.creds = e.target.checked ? [...r.creds, c.id] : r.creds.filter(x => x !== c.id); touch(); } }), c.short)))));
  });
  const ruleSec = h("section", { class: "panel req-sec" }, h("div", { class: "panel-head" }, h("h2", null, "Rules"), h("button", { class: "btn sm", onclick: () => { m.rules.push({ id: rid(), dept: "*", positions: [], creds: [] }); touch(true); } }, "Add rule")),
    h("div", { class: "panel-body" }, rules.length ? rules : h("p", { class: "muted" }, "No rules yet. Add one to start assigning credentials.")));
  const prev = h("section", { class: "panel req-sec" }, h("div", { class: "panel-head" }, h("h2", null, "Who needs what"), h("span", { class: "muted" }, "Result of the rules above")), h("div", { id: "mxprev" }));
  const save = h("button", { class: "btn primary" }, "Save requirements");
  save.onclick = () => busy(save, async () => {
    if (m.credentials.some(c => !c.short || !c.name.trim())) { toast("Every credential needs a code and a name.", "bad"); return; }
    must(await sb.from("settings").upsert({ key: "matrix", value: m, updated_at: new Date().toISOString() }, { onConflict: "key" }));
    S.dirty = false; await reload("Requirements saved");
  });
  const bar = h("div", { class: "savebar", id: "savebar", hidden: !S.dirty }, h("span", { class: "grow" }, h("strong", null, "Unsaved changes"), h("span", { class: "muted" }, " · staff see the new requirements as soon as you save")),
    h("button", { class: "btn", onclick: () => { S.dirty = false; renderRequirements(); } }, "Discard"), save);
  setMain(head, ruleSec, prev, creds, depts, posns, bar);
  fillPreview();
}
function fillPreview() {
  const m = S.draft, box = $("#mxprev"); if (!box) return;
  if (!m.departments.length || !m.positions.length) { box.replaceChildren(h("div", { class: "empty" }, h("p", { class: "muted" }, "Add departments and positions to see the result."))); return; }
  box.replaceChildren(h("div", { class: "tbl" }, h("table", { class: "mx" },
    h("thead", null, h("tr", null, h("th", null, "Department"), m.positions.map(x => h("th", null, x)))),
    h("tbody", null, m.departments.map(d => h("tr", null, h("td", { style: "font-weight:600" }, d.name),
      m.positions.map(x => { const req = requiredFor({ dept: d.id, position: x }, m); return h("td", null, req.length ? req.map(c => h("span", { class: "mini neutral" }, c.short)) : h("span", { class: "sub" }, "—")); })))))));
}

/* ---------- boot ---------- */
async function myAccount() {
  const r = await sb.rpc("my_account");
  if (!r.error) return (r.data || [])[0] || null;
  const adm = await sb.rpc("is_admin"); // database not yet updated with roles
  return adm.data === true ? { role: "admin", depts: [], full_name: "" } : null;
}
async function startSession(session, acct) {
  S.email = (session.user.email || "").toLowerCase();
  S.role = acct.role || "admin"; S.depts = acct.depts || []; S.myName = acct.full_name || "";
  if (S.role === "admin" || S.role === "hr") { S.isHR = S.role === "hr"; return startAdmin(session); }
  S.approver = true;
  try { await loadPublic(); await loadQueue(); render(); } catch (e) { console.error(e); setMain(notice("Your page couldn't load", errText(e))); }
}
async function startAdmin(session) {
  S.email = (session.user.email || "").toLowerCase();
  S.isAdmin = true;
  const h0 = (location.hash || "").slice(1);
  S.tab = TABS.some(t => t[0] === h0) ? h0 : "compliance"; S.built = null;
  try { await refresh(); } catch (e) { console.error(e); setMain(notice("The admin view couldn't load", errText(e))); }
}
(async function boot() {
  if (!window.supabase || !CFG.supabaseUrl || /YOUR-PROJECT/.test(CFG.supabaseUrl)) {
    setMain(notice("The portal isn't connected yet", "Add the Supabase project URL and anon key to config.js. See README.md for the setup steps.")); return;
  }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  S.ready = true;
  try {
    const { data } = await sb.auth.getSession();
    if (data.session) {
      const acct = await myAccount();
      if (acct) return startSession(data.session, acct);
      await sb.auth.signOut();
    }
    await loadPublic(); render();
  } catch (e) { console.error(e); setMain(notice("The portal couldn't load", errText(e))); }
})();
