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
  ready: false, isAdmin: false, email: "",
  matrix: null, jds: [], staff: [], tab: "compliance", built: null,
  person: null, sent: {}, signed: {}, finished: false,
  f: { dept: "", status: "", q: "" }, draft: null, dirty: false
};
let sb = null;
const WARN_DAYS = 60;
const MAX_PDF = 5 * 1024 * 1024;
const TONE = { missing: "bad", expired: "bad", rejected: "bad", pending: "pend", expiring: "warn", valid: "ok" };
const SCFHS_CLASSES = ["Consultant", "Senior Registrar / Senior Specialist", "Registrar / Specialist", "Resident", "General Practitioner", "Senior Specialist Nurse", "Specialist Nurse", "Nurse Technician", "Other"];
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
const jdsFor = p => p ? S.jds.filter(j => !j.archived && (j.dept === "*" || j.dept === p.dept) && (!j.positions || !j.positions.length || j.positions.includes(p.position))) : [];
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
function pendingQueue() {
  const out = [];
  for (const p of S.staff) for (const r of summarize(p).rows) if (r.k === "pending") out.push({ p, ...r });
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
  S.jds = jds.map(j => ({ id: j.id, title: j.title, code: j.code, dept: j.dept, positions: j.positions || [], path: j.file_path, fileName: j.file_name, version: j.version, archived: j.archived, history: j.history || [], updatedAt: j.updated_at }));
}
async function refresh() {
  await loadPublic();
  if (S.isAdmin) {
    const [subs, sigs, roster] = await Promise.all([fetchAll("current_submissions"), fetchAll("jd_signatures"), fetchAll("roster")]);
    const by = {};
    const person = (eid) => { const k = eid.trim().toLowerCase(); return by[k] || (by[k] = { uid: k, employeeId: eid.trim(), fullName: "", dept: "", position: "", mobile: "", updatedAt: "", creds: {}, signatures: {}, onRoster: false, hasSubmitted: false }); };
    const touchPerson = (u, r, ts) => { u.hasSubmitted = true; if (!u.updatedAt || ts > u.updatedAt) { u.updatedAt = ts; if (!u.onRoster || !u.fullName) u.fullName = r.full_name; if (!u.onRoster || !u.dept) { u.dept = r.dept; u.position = r.position; } if (r.mobile) u.mobile = r.mobile; } };
    for (const r of roster) { const u = person(r.employee_id); u.onRoster = true; u.fullName = r.full_name || ""; u.dept = r.dept || ""; u.position = r.position || ""; }
    for (const r of subs) { const u = person(r.employee_id);
      u.creds[r.cred_id] = { id: r.id, number: r.number, classification: r.classification, specialty: r.specialty, issueDate: r.issue_date, expiryDate: r.expiry_date, path: r.file_path, fileName: r.file_name, fileType: r.file_type, uploadedAt: r.uploaded_at, status: r.status, note: r.review_note, asName: r.full_name };
      touchPerson(u, r, r.uploaded_at); }
    for (const r of sigs) { const u = person(r.employee_id); const cur = u.signatures[r.jd_id];
      if (!cur || r.version > cur.version) u.signatures[r.jd_id] = { version: r.version, typedName: r.typed_name, signedAt: r.signed_at, path: r.signature_path, fileName: "signature.png" };
      touchPerson(u, r, r.signed_at); }
    S.staff = Object.values(by);
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
const TABS = [["compliance", "Compliance"], ["review", "Review queue"], ["jds", "Job descriptions"], ["requirements", "Requirements"]];
function renderTabs() {
  const nav = $("#tabs"); nav.replaceChildren();
  nav.hidden = !S.isAdmin; $("#stripe").hidden = S.isAdmin;
  if (!S.isAdmin) return;
  const pend = pendingQueue().length;
  for (const [id, label] of TABS) nav.append(h("button", { class: "tab", role: "tab", "aria-selected": String(S.tab === id), onclick: () => switchTab(id) }, label, id === "review" && pend ? h("span", { class: "cnt num" }, pend) : null));
}
function renderWho() {
  const w = $("#who"); w.replaceChildren();
  if (S.isAdmin) w.append(h("div", { style: "min-width:0;text-align:right" }, h("div", { class: "w-name" }, S.email), h("div", { class: "w-role" }, "Credentials office (admin)")),
    h("button", { class: "btn sm", onclick: async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); } }, "Sign out"));
  else w.append(h("button", { class: "btn sm ghost-paper", onclick: adminLogin }, "Admin sign in"));
}
function switchTab(id) { S.tab = id; S.built = null; try { history.replaceState(null, "", "#" + id); } catch (e) {} render(); }
function render() {
  if (!S.ready) return;
  renderTabs(); renderWho();
  if (!S.isAdmin) return renderStaff();
  ({ compliance: renderCompliance, review: renderReview, jds: renderJds, requirements: renderRequirements }[S.tab] || renderCompliance)();
}
function setMain(...kids) { $("#main").replaceChildren(...kids); }
const notice = (title, text) => h("div", { class: "panel empty" }, h("h2", null, title), h("p", { class: "muted" }, text));

function adminLogin() {
  const email = h("input", { type: "email", id: "ad-email", autocomplete: "username", value: CFG.adminEmail || "" });
  const pass = h("input", { type: "password", id: "ad-pass", autocomplete: "current-password" });
  const err = h("p", { class: "err", hidden: true });
  const go = h("button", { class: "btn primary" }, "Sign in");
  go.onclick = () => busy(go, async () => {
    err.hidden = true;
    const res = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (res.error) { err.textContent = errText(res.error); err.hidden = false; return; }
    const adm = await sb.rpc("is_admin");
    if (adm.data !== true) { await sb.auth.signOut(); err.textContent = "This account doesn't have admin access."; err.hidden = false; return; }
    closeModal(); await startAdmin(res.data.session);
  });
  pass.onkeydown = e => { if (e.key === "Enter") go.click(); };
  openModal({ title: "Admin sign in", sub: "For the credentials office only. Staff don't need to sign in.",
    body: [h("label", { class: "f", for: "ad-email" }, "Email", email), h("label", { class: "f", for: "ad-pass" }, "Password", pass), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go] });
  setTimeout(() => (email.value ? pass : email).focus(), 40);
}

/* ---------- staff: submission form (no sign-in) ---------- */
function renderStaff() {
  if (!S.matrix) return setMain(notice("The portal isn't open yet", "The credentials office is still setting up the requirements. Check back soon."));
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Submit your credentials"),
    h("p", { class: "muted" }, "Enter your details, then upload your certificates and sign your job description. The credentials office reviews every document.")));
  if (S.finished) return setMain(head, finishedPanel());
  if (!S.person) return setMain(head, detailsPanel());
  const p = S.person;
  const who = h("div", { class: "panel profile" },
    pf("Name", p.fullName), pf("Employee ID", p.employeeId), pf("Department", deptName(p.dept)), pf("Position", p.position),
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
  const parts = [head, who, creds];
  if (jlist.length) parts.push(h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Job description")), jl));
  const nSent = Object.keys(S.sent).length + Object.keys(S.signed).length;
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
  f.dept.value = p.dept || ""; f.position.value = p.position || "";
  const err = h("p", { class: "err", hidden: true });
  const preview = h("p", { class: "hint" });
  const upd = () => { const req = requiredFor({ dept: f.dept.value, position: f.position.value }); preview.textContent = f.dept.value && f.position.value ? (req.length ? "You'll be asked for: " + req.map(c => c.short).join(", ") : "No credentials are set for this combination yet.") : ""; };
  f.dept.onchange = upd; f.position.onchange = upd; upd();
  const go = h("button", { class: "btn primary" }, "Continue to uploads");
  go.onclick = () => busy(go, async () => {
    const v = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
    const missing = [!v.employeeId && "employee ID", !v.fullName && "full name", !v.dept && "department", !v.position && "position"].filter(Boolean);
    if (missing.length) { err.textContent = "Enter your " + missing.join(", ") + "."; err.hidden = false; return; }
    if (v.fullName.length < 2) { err.textContent = "Enter your full name."; err.hidden = false; return; }
    const ok = await sb.rpc("employee_ok", { eid: v.employeeId });
    if (ok.data === false) { err.textContent = "That employee ID isn't on the staff list. Check the number, or contact the credentials office."; err.hidden = false; return; }
    if (!S.lastPerson || S.lastPerson.employeeId !== v.employeeId) { S.sent = {}; S.signed = {}; }
    S.person = v; S.lastPerson = v; render(); window.scrollTo(0, 0);
  });
  return h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", null, "Your details"), h("span", { class: "muted" }, "Use your name as it appears on your SCFHS registration")),
    h("div", { class: "panel-body", style: "display:flex;flex-direction:column;gap:14px" },
      h("div", { class: "grid2" },
        h("label", { class: "f", for: "pf-emp" }, h("span", { class: "req" }, "Employee ID"), f.employeeId),
        h("label", { class: "f", for: "pf-name" }, h("span", { class: "req" }, "Full name"), f.fullName),
        h("label", { class: "f", for: "pf-dept" }, h("span", { class: "req" }, "Department"), f.dept),
        h("label", { class: "f", for: "pf-pos" }, h("span", { class: "req" }, "Position"), f.position),
        h("label", { class: "f full", for: "pf-mob" }, "Mobile (optional)", f.mobile)),
      preview, err, h("div", { class: "row" }, go)));
}
function finishedPanel() {
  const items = Object.entries(S.sent).map(([id, s]) => ((M().credentials.find(c => c.id === id) || {}).short || id) + (s.fileName ? " (" + s.fileName + ")" : ""));
  const jds = Object.keys(S.signed).map(id => "Job description: " + ((S.jds.find(j => j.id === id) || {}).title || ""));
  return h("div", { class: "panel empty" }, h("h2", null, "Thank you, your documents were submitted"),
    h("p", { class: "muted" }, `Submitted for ${S.person.fullName} (employee ID ${S.person.employeeId}). The credentials office will review them and contact you if anything is missing.`),
    h("ul", { class: "done-list" }, [...items, ...jds].map(t => h("li", null, t))),
    h("p", { class: "hint" }, "You can close this page now."),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => { S.finished = false; render(); } }, "Add more documents"),
      h("button", { class: "btn ghost", onclick: () => { S.finished = false; S.person = null; S.lastPerson = null; S.sent = {}; S.signed = {}; render(); } }, "Start over for someone else")));
}
const personFields = () => ({ employee_id: S.person.employeeId, full_name: S.person.fullName, dept: S.person.dept, position: S.person.position });
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
    must(await sb.from("submissions").insert({ ...personFields(), mobile: S.person.mobile || null, ...rec }));
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
    must(await sb.from("jd_signatures").insert({ ...personFields(), jd_id: j.id, version: j.version, typed_name: typed.value.trim(), signature_path: path }));
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
      h("div", { class: "page-head" }, h("div", null, h("h1", null, "Compliance"), h("p", { class: "muted" }, "Everyone who has submitted (and everyone on the staff roster, if you've imported one) against the requirements for their department and position. Select a person to review their documents.")),
        h("div", { class: "row" }, h("button", { class: "btn", onclick: e => busy(e.currentTarget, () => reload("Refreshed")) }, "Refresh"), h("button", { class: "btn", onclick: exportCsv }, "Export CSV"))),
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
      h("td", null, h("div", null, deptName(p.dept)), h("div", { class: "sub" }, p.position), p.creds.scfhs && p.creds.scfhs.classification ? h("div", { class: "sub" }, "SCFHS: " + p.creds.scfhs.classification) : null),
      h("td", null, s.rows.length ? s.rows.map(r => h("span", { class: "mini " + TONE[r.k], title: `${r.c.name}: ${r.label}${r.exp ? " (expires " + fmtDate(r.exp) + ")" : ""}` }, r.c.short)) : h("span", { class: "sub" }, "None set")),
      h("td", { class: "num" }, s.jds.length ? h("span", { class: "chip " + (s.jdOut ? "warn" : "ok") }, `${s.jds.length - s.jdOut}/${s.jds.length} signed`) : h("span", { class: "sub" }, "—")),
      h("td", null, h("span", { class: "chip " + s.overall.k }, s.overall.label)),
      h("td", { class: "num sub" }, fmtTs(p.updatedAt))))))));
}
function exportCsv() {
  const esc = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [["Employee ID", "Full name", "Department", "Position", "Mobile", "SCFHS no.", "SCFHS classification", "SCFHS specialty", "Requirement", "Status", "Certificate no.", "Issue date", "Expiry date", "Submitted"].join(",")];
  for (const p of S.staff) {
    const s = summarize(p), sc = p.creds.scfhs || {};
    const who = [p.employeeId, p.fullName, deptName(p.dept), p.position, p.mobile, sc.number, sc.classification, sc.specialty];
    for (const r of s.rows) lines.push([...who, r.c.short, r.label, r.item && r.item.number, r.item && r.item.issueDate, r.exp, r.item && r.item.uploadedAt && r.item.uploadedAt.slice(0, 10)].map(esc).join(","));
    for (const x of s.jds) lines.push([...who, "JD: " + x.j.title + " v" + x.j.version, x.signed ? "Signed" : "Not signed", "", "", "", x.sig && x.sig.signedAt && x.sig.signedAt.slice(0, 10)].map(esc).join(","));
  }
  saveBlob(`AMH-credentials-compliance-${todayIso()}.csv`, new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
}

async function setReview(item, status, note) {
  must(await sb.from("submissions").update({ status, review_note: note || null, reviewed_at: new Date().toISOString(), reviewed_by: S.email }).eq("id", item.id));
  await reload(status === "verified" ? "Marked as verified" : "Marked as returned");
}
function returnModal(r, after) {
  const note = h("textarea", { id: "rv-note", rows: "3", placeholder: "For example: certificate has expired, or the image is unreadable." });
  const go = h("button", { class: "btn primary" }, "Mark as returned");
  go.onclick = () => busy(go, async () => { if (!note.value.trim()) { note.focus(); return; } await setReview(r.item, "rejected", note.value.trim()); closeModal(); after && after(); });
  openModal({ title: "Return " + r.c.short, sub: "Staff don't sign in, so contact the person with this reason and ask them to submit again.", body: h("label", { class: "f", for: "rv-note" }, "Reason", note), foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go] });
}
function reviewButtons(r, after) {
  if (!r.item) return [];
  const v = h("button", { class: "btn sm ghost", onclick: () => viewStaffFile(r.item, r.c.name) }, "View");
  const ok = h("button", { class: "btn sm" }, "Verify");
  ok.onclick = () => busy(ok, async () => { await setReview(r.item, "verified"); after && after(); });
  const no = h("button", { class: "btn sm danger", onclick: () => returnModal(r, after) }, "Return");
  return r.k === "valid" || r.k === "expiring" ? [v, no] : r.k === "rejected" ? [v, ok] : r.k === "expired" ? [v] : [v, ok, no];
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
      h("div", { class: "acts" }, reviewButtons(r, () => staffDetail(uid))),
      r.k === "rejected" ? h("div", { class: "cred-note" }, "Returned: " + (r.note || "")) : null));
  }
  if (!s.rows.length) list.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "No credentials are required for this department and position.")));
  const jl = h("div", { class: "list panel" });
  for (const x of s.jds) jl.append(h("div", { class: "cred" }, h("div", { class: "code" }, "JD"),
    h("div", { style: "min-width:0" }, h("div", { class: "cred-name" }, x.j.title), h("div", { class: "cred-meta" }, x.sig ? `Signed version ${x.sig.version} as “${x.sig.typedName}” on ${fmtTs(x.sig.signedAt)}` : "Not signed")),
    h("span", { class: "chip " + (x.signed ? "ok" : "warn") }, x.signed ? "Signed" : "Not signed"),
    h("div", { class: "acts" }, x.sig ? h("button", { class: "btn sm ghost", onclick: () => viewStaffFile(x.sig, "Signature: " + x.j.title) }, "Signature") : null)));
  if (!s.jds.length) jl.append(h("div", { class: "empty" }, h("p", { class: "muted" }, "No job description applies to this position.")));
  openModal({
    title: p.fullName || "Staff member", sub: `${deptName(p.dept)} · ${p.position || "—"} · Employee ID ${p.employeeId}`, wide: true,
    body: [h("div", { class: "row" }, h("span", { class: "chip " + s.overall.k }, s.overall.label), p.mobile ? h("span", { class: "muted num" }, p.mobile) : null, p.onRoster ? h("span", { class: "muted" }, "On staff roster") : null),
      h("h3", null, "Credentials"), list, h("h3", null, "Job description"), jl],
    foot: [h("button", { class: "btn primary", onclick: closeModal }, "Done")]
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

/* ---------- admin: job descriptions ---------- */
function audienceText(j) { return `${deptName(j.dept)} · ${j.positions && j.positions.length ? j.positions.join(", ") : "all positions"}`; }
function renderJds() {
  S.built = "jds";
  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, "Job descriptions"), h("p", { class: "muted" }, "Upload a job description as a PDF and choose who it applies to. Staff in that department and position are asked to read and sign it when they submit. Replacing the file issues a new version that everyone signs again.")),
    h("button", { class: "btn primary", onclick: () => jdModal() }, "Upload job description"));
  const active = S.jds.filter(j => !j.archived).sort((a, b) => a.title.localeCompare(b.title));
  if (!active.length) return setMain(head, notice("No job descriptions issued", "Upload the first job description, for example the Emergency Medicine Consultant JD, and assign it to that department and position."));
  const list = h("div", { class: "list" });
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
  setMain(head, h("section", { class: "panel" }, list));
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
    const body = { title: title.value.trim(), code: code.value.trim() || null, dept: dept.value, positions: pos.filter(p => p.cb.checked).map(p => p.x), file_path: path, file_name: f.name, updated_at: now };
    if (j) {
      const hist = (j.history || []).concat([{ version: j.version, file_path: j.path, file_name: j.fileName, issued_at: j.updatedAt }]);
      must(await sb.from("job_descriptions").update({ ...body, version: j.version + 1, history: hist }).eq("id", j.id));
    } else must(await sb.from("job_descriptions").insert({ ...body, version: 1 }));
    closeModal(); await reload(j ? `Version ${j.version + 1} issued` : "Job description issued");
  });
  openModal({
    title: j ? "New version of " + j.title : "Upload job description", sub: j ? `Staff who signed version ${j.version} will be asked to sign again.` : "Staff matching the department and positions below will be asked to sign it.",
    body: [h("div", { class: "grid2" }, h("label", { class: "f full", for: "jd-title" }, "Title", title), h("label", { class: "f", for: "jd-code" }, "Document code", code), h("label", { class: "f", for: "jd-dept" }, "Department", dept)),
      h("div", { class: "f" }, h("span", null, "Positions"), h("div", { class: "checks" }, pos.map(p => p.el)), h("span", { class: "hint" }, "Leave all unticked to include every position in the department.")),
      h("div", { class: "drop" }, file, h("span", { class: "hint" }, "PDF, up to 20 MB.")), err],
    foot: [h("button", { class: "btn", onclick: closeModal }, "Cancel"), go]
  });
}
function jdSignatures(j) {
  const people = S.staff.filter(p => jdsFor(p).some(x => x.id === j.id)).sort((a, b) => (a.fullName || "").localeCompare(b.fullName || ""));
  const body = people.length ? h("div", { class: "tbl" }, h("table", null, h("thead", null, h("tr", null, ["Staff member", "Position", "Status", ""].map(t => h("th", null, t)))),
    h("tbody", null, people.map(p => { const s = p.signatures[j.id]; const ok = s && s.version === j.version;
      return h("tr", null, h("td", null, h("div", { style: "font-weight:600" }, p.fullName), h("div", { class: "sub num" }, p.employeeId)), h("td", null, deptName(p.dept), h("div", { class: "sub" }, p.position)),
        h("td", null, h("span", { class: "chip " + (ok ? "ok" : "warn") }, ok ? "Signed " + fmtTs(s.signedAt) : s ? `Signed v${s.version} only` : "Not signed")),
        h("td", null, s ? h("button", { class: "btn sm ghost", onclick: () => viewStaffFile(s, "Signature: " + p.fullName) }, "Signature") : null)); }))))
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
      const adm = await sb.rpc("is_admin");
      if (adm.data === true) return startAdmin(data.session);
      await sb.auth.signOut();
    }
    await loadPublic(); render();
  } catch (e) { console.error(e); setMain(notice("The portal couldn't load", errText(e))); }
})();
