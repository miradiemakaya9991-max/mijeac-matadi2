"use strict";

const TOKEN_KEY = "mijeac_auth_token";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&",
  "<": "<",
  ">": ">",
  '"': """,
  "'": "'"
}[c]));
const todayLocal = () => new Date().toLocaleDateString("en-CA");

let state = { users: [], parishes: [], youths: [], activities: [], participations: [], logs: [] },
  me = null,
  tab = "dash",
  editing = null,
  activityEdit = null,
  selectedActivity = null,
  searchText = "",
  baptismFilter = "all",
  parishFilter = "all",
  toastTimer;

async function api(url, method = "GET", body = null) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ ok: false, error: "Réponse serveur invalide." }));

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    me = null;
    renderAuth();
    throw new Error("Session expirée. Veuillez vous reconnecter.");
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Erreur lors de l'opération.");
  }
  if (data.me) me = data.me;
  if (data.state) state = data.state;
  return data;
}

function msg(t) {
  let e = $("#toast");
  if (!e) return alert(t);
  e.textContent = t;
  e.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (e.style.display = "none"), 3500);
}

function current() { return me; }
function admin() { return current()?.role === "ADMIN_DISTRICT"; }
function parishId() { return current()?.parishId || ""; }
function allowedYouth(j) { return admin() || j.parishId === parishId(); }
function allowedActivity(a) { return admin() || !a.parishId || a.parishId === parishId(); }
function pname(pid) { return state.parishes.find(p => p.id === pid)?.name || "—"; }
function yname(y) { return [y.lastName, y.firstName].filter(Boolean).join(" "); }

function isBaptized(y) {
  const v = String(y?.baptized ?? y?.bapt ?? "Non").trim().toLowerCase();
  return ["oui", "yes", "true", "1", "baptisé", "baptise"].includes(v);
}
function baptismLabel(y) { return isBaptized(y) ? "Oui" : "Non"; }
function matchesBaptism(y) {
  return baptismFilter === "all" || (baptismFilter === "yes" && isBaptized(y)) || (baptismFilter === "no" && !isBaptized(y));
}

async function init() {
  applyTheme();
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      await api("/api/state");
      tab = me?.mustChange ? "profile" : "dash";
      return render();
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  renderAuth();
}

function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem("mijeac_theme") || "light";
}

function toggleTheme() {
  let t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("mijeac_theme", t);
  applyTheme();
}

function renderAuth() {
  $("#auth")?.classList.remove("hidden");
  $("#nav")?.classList.add("hidden");
  $("#app")?.classList.add("hidden");
  $("#logoutBtn")?.classList.add("hidden");
  if ($("#who")) $("#who").textContent = "Gestion du ministère de jeunes";

  $("#auth").innerHTML = `
    <div class="card">
      <div class="center">
        <h2>Connexion à MIJEAC</h2>
        <p class="note">District Matadi 2 — Base de données synchronisée.</p>
      </div>
      <form onsubmit="login(event)">
        <label>Identifiant ou adresse e-mail</label>
        <input id="loginEmail" type="text" required autocomplete="username" placeholder="admin ou votre e-mail">
        <label style="margin-top:10px">Mot de passe</label>
        <input id="loginPass" type="password" required autocomplete="current-password" placeholder="Votre mot de passe">
        <button class="b" id="loginSubmitBtn" style="width:100%;margin-top:14px">Se connecter</button>
      </form>
      <hr>
      <h3>Pas encore de compte responsable ?</h3>
      <p class="note">Envoyez une demande. L’administrateur du district devra l’approuver et vous affecter une paroisse.</p>
      <button class="b alt" style="width:100%" onclick="signupForm()">Demander un compte</button>
    </div>`;
}

function signupForm() {
  $("#auth").innerHTML = `
    <div class="card">
      <h2>Demande de création de compte</h2>
      <form onsubmit="signup(event)">
        <label>Nom complet</label><input id="suName" required>
        <label>E-mail</label><input id="suEmail" type="email" required>
        <label>Mot de passe souhaité</label><input id="suPass" type="password" minlength="6" required>
        <label>Confirmer le mot de passe</label><input id="suConfirm" type="password" minlength="6" required>
        <div class="row" style="margin-top:12px">
          <button class="b">Envoyer la demande</button>
          <button type="button" class="b alt" onclick="renderAuth()">Retour</button>
        </div>
      </form>
      <p class="note">Votre compte restera en attente jusqu’à son approbation par l’administrateur.</p>
    </div>`;
}

async function login(e) {
  e.preventDefault();
  const btn = $("#loginSubmitBtn");
  if (btn) btn.disabled = true;
  try {
    const rawLogin = $("#loginEmail").value.trim();
    const email = rawLogin.toLowerCase() === "admin" ? "admin" : rawLogin.toLowerCase();
    const password = $("#loginPass").value;
    const data = await api("/api/login", "POST", { email, password });
    localStorage.setItem(TOKEN_KEY, data.token);
    tab = me.mustChange ? "profile" : "dash";
    render();
  } catch (err) {
    msg(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function signup(e) {
  e.preventDefault();
  const name = $("#suName").value.trim();
  const email = $("#suEmail").value.trim().toLowerCase();
  const password = $("#suPass").value;
  const confirm = $("#suConfirm").value;

  if (password !== confirm) return msg("Les deux mots de passe ne correspondent pas.");
  try {
    await api("/api/signup", "POST", { name, email, password });
    msg("Demande envoyée. Attendez l’approbation du district.");
    renderAuth();
  } catch (err) {
    msg(err.message);
  }
}

async function logout() {
  try {
    await api("/api/logout", "POST");
  } catch (e) {}
  localStorage.removeItem(TOKEN_KEY);
  me = null;
  editing = null;
  activityEdit = null;
  selectedActivity = null;
  renderAuth();
}

function render() {
  const u = current();
  if (!u) return renderAuth();

  $("#auth").classList.add("hidden");
  $("#nav").classList.remove("hidden");
  $("#app").classList.remove("hidden");
  $("#logoutBtn").classList.remove("hidden");
  $("#who").textContent = (admin() ? "Administrateur du district" : "Responsable de " + pname(u.parishId)) + " · " + u.name;

  let tabs = [
    ["dash", "📊 Tableau de bord"],
    ["youth", "👥 Jeunes"],
    ["activities", "📅 Activités"],
    ["participation", "✓ Participations"],
    ["profile", "👤 Mon compte"]
  ];
  if (admin()) {
    tabs.push(["parishes", "⛪ Paroisses"], ["users", "🔐 Comptes utilisateurs"], ["logs", "📋 Historique"], ["manual", "📖 Guide"]);
  }
  if (u.mustChange) tab = "profile";

  $("#nav").innerHTML = tabs
    .map(([k, l]) => `<button class="${tab === k ? "on" : ""}" onclick="go('${k}')">${l}</button>`)
    .join("");
  $("#app").innerHTML = ({ dash, youth, activities, participation, profile, parishes, users, logs, manual }[tab] || dash)();
}

function go(t) {
  if (current()?.mustChange && t !== "profile") {
    return msg("Veuillez d'abord modifier votre mot de passe provisoire.");
  }
  tab = t;
  editing = null;
  activityEdit = null;
  render();
}

function dash() { return dashboard(); }

function dashboard() {
  let ys = state.youths.filter(allowedYouth),
    active = ys.filter(y => y.status === "Actif"),
    acts = state.activities.filter(allowedActivity);
  let baptized = active.filter(isBaptized).length,
    notBaptized = active.length - baptized;
  let p = admin() ? state.parishes : [state.parishes.find(x => x.id === parishId())].filter(Boolean);
  let pendingCount = state.users.filter(x => x.status === "PENDING").length;

  return `
    <div class="grid">
      <div class="card kpi"><b>${active.length}</b><span>Jeunes actifs ${admin() ? "du district" : "de la paroisse"}</span></div>
      ${admin() ? `<div class="card kpi"><b>${state.parishes.length}</b><span>Paroisses</span></div>` : ""}
      <div class="card kpi"><b>${active.filter(y => y.sex === "M").length} / ${active.filter(y => y.sex === "F").length}</b><span>Garçons / Filles</span></div>
      <div class="card kpi"><b>${baptized}</b><span>Jeunes actifs baptisés</span></div>
      <div class="card kpi"><b>${notBaptized}</b><span>Jeunes actifs non baptisés</span></div>
      <div class="card kpi"><b>${acts.length}</b><span>Activités enregistrées</span></div>
      ${admin() ? `<div class="card kpi"><b>${pendingCount}</b><span>Demandes de comptes en attente</span></div>` : ""}
    </div>
    <div class="card">
      <h2>Jeunes actifs par paroisse</h2>
      ${p.map(x => {
        let n = active.filter(y => y.parishId === x.id).length;
        return `<div class="bar"><span>${esc(x.name)}</span><i style="width:${Math.max(3, (n * 100) / Math.max(1, active.length))}%"></i><b>${n}</b></div>`;
      }).join("") || '<p class="note">Aucune paroisse enregistrée.</p>'}
    </div>
    <div class="card">
      <h2>Prochaines activités</h2>
      ${acts
        .filter(a => String(a.date).slice(0, 10) >= todayLocal())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .slice(0, 5)
        .map(a => `<p><b>${esc(a.title)}</b> — ${esc(String(a.date).slice(0, 10))} · ${esc(a.location || "Lieu à préciser")}</p>`)
        .join("") || '<p class="note">Aucune activité programmée.</p>'}
    </div>`;
}

function filteredYouths() {
  return state.youths
    .filter(allowedYouth)
    .filter(y => !admin() || parishFilter === "all" || y.parishId === parishFilter)
    .filter(y => matchesBaptism(y))
    .filter(y => !searchText || yname(y).toLowerCase().includes(searchText.toLowerCase()));
}

function updateYouthView() {
  const rows = document.querySelector("#youthRows");
  if (rows) rows.innerHTML = youthRows();
}

function youth() {
  if (editing) return youthForm();
  return `
    <div class="row">
      <input placeholder="Rechercher un jeune…" value="${esc(searchText)}" oninput="searchText=this.value;updateYouthView()">
      ${admin() ? `<select aria-label="Filtrer par paroisse" onchange="parishFilter=this.value;updateYouthView()"><option value="all" ${parishFilter === "all" ? "selected" : ""}>Toutes les paroisses</option>${state.parishes.map(p => `<option value="${esc(p.id)}" ${parishFilter === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>` : ""}
      <select aria-label="Filtrer par baptême" onchange="baptismFilter=this.value;updateYouthView()">
        <option value="all" ${baptismFilter === "all" ? "selected" : ""}>Tous les jeunes</option>
        <option value="yes" ${baptismFilter === "yes" ? "selected" : ""}>Baptisés uniquement</option>
        <option value="no" ${baptismFilter === "no" ? "selected" : ""}>Non baptisés uniquement</option>
      </select>
      <button class="b" onclick="newYouth()">＋ Ajouter un jeune</button>
      <button class="b alt" onclick="exportCSV('youths')">⬇ CSV</button>
    </div>
    <section id="youthRows" class="youth-list">${youthRows()}</section>`;
}

function youthRows() {
  return (
    filteredYouths()
      .map(
        y => `
      <article class="youth-card">
        <div class="youth-avatar">${y.photo ? `<img src="${y.photo}" alt="Photo de ${esc(yname(y))}">` : `<span>👤</span>`}</div>
        <div class="youth-info">
          <h3>${esc(yname(y))}</h3>
          <p>${esc(y.age || "Âge non précisé")} ans · ${y.sex === "M" ? "Garçon" : y.sex === "F" ? "Fille" : "Sexe non précisé"}</p>
          <p>${esc(pname(y.parishId))} · ${esc(y.phone || "Téléphone non renseigné")}</p>
          <div class="youth-tags">
            <span class="tag ${isBaptized(y) ? "ok" : "warn"}">${isBaptized(y) ? "Baptisé" : "Non baptisé"}</span>
            <span class="tag">${esc(y.status || "Actif")}</span>
          </div>
        </div>
        <div class="youth-actions"><button class="b alt" onclick="editYouth('${esc(y.id)}')">Modifier la fiche</button></div>
      </article>`
      )
      .join("") || '<div class="card note">Aucun jeune ne correspond à ce filtre.</div>'
  );
}

function newYouth() { editing = "new"; render(); }
function editYouth(yid) { editing = yid; render(); }

function youthForm() {
  let y = editing === "new" ? {} : state.youths.find(x => x.id === editing) || {},
    pars = admin() ? state.parishes : state.parishes.filter(p => p.id === parishId());

  return `
    <div class="card">
      <h2>${editing === "new" ? "Ajouter un jeune" : "Modifier la fiche d’un jeune"}</h2>
      <form onsubmit="saveYouth(event)">
        <div class="form">
          ${field("Nom", "lastName", y.lastName)}
          ${field("Prénom", "firstName", y.firstName)}
          ${selectField("Sexe", "sex", y.sex, [["M", "Masculin"], ["F", "Féminin"]])}
          ${field("Âge", "age", y.age, "number")}
          ${field("Téléphone", "phone", y.phone, "tel")}
          ${field("E-mail", "email", y.email, "email")}
          ${field("Adresse", "address", y.address)}
          ${field("Niveau d’études", "studies", y.studies)}
          ${field("Fonction à l’église", "churchRole", y.churchRole)}
          ${selectField("Situation", "situation", y.situation, [["Élève", "Élève"], ["Étudiant", "Étudiant"], ["Employé(e)", "Employé(e)"], ["Chômeur", "Chômeur"]])}
          <div>
            <label>Paroisse</label>
            <select name="parishId" required>
              ${pars.map(p => `<option value="${esc(p.id)}" ${y.parishId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
            </select>
          </div>
          ${selectField("Statut", "status", y.status || "Actif", [["Actif", "Actif"], ["Inactif", "Inactif"], ["Transféré", "Transféré"]])}
          ${selectField("Baptisé", "baptized", y.baptized || "Non", [["Oui", "Oui"], ["Non", "Non"]])}
          <div class="photo-field">
            <label>Photo du jeune</label>
            <div class="photo-editor">
              <div id="photoPreview" class="photo-preview">${y.photo ? `<img src="${y.photo}" alt="Photo actuelle">` : `<span>👤</span>`}</div>
              <div class="photo-controls">
                <input type="file" name="photoFile" id="youthPhotoFile" accept="image/*" capture="environment" onchange="previewYouthPhoto(this)">
                <small class="note">Choisissez une photo dans la galerie ou prenez-en une avec l’appareil photo.</small>
                ${y.photo ? `<button type="button" class="b alt" onclick="removeYouthPhoto()">Supprimer la photo actuelle</button>` : ""}
                <input type="hidden" name="removePhoto" id="removeYouthPhotoFlag" value="0">
              </div>
            </div>
          </div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="b">Enregistrer</button>
          <button type="button" class="b alt" onclick="editing=null;render()">Annuler</button>
          ${editing !== "new" && admin() ? `<button type="button" class="b danger" onclick="deleteYouth('${esc(y.id)}')">Supprimer</button>` : ""}
        </div>
      </form>
    </div>`;
}

function field(label, name, value = "", type = "text") {
  return `<div><label>${label}</label><input name="${name}" type="${type}" value="${esc(value ?? "")}"></div>`;
}

function selectField(label, name, value, opts) {
  return `<div><label>${label}</label><select name="${name}">${opts
    .map(([v, l]) => `<option value="${esc(v)}" ${value === v ? "selected" : ""}>${esc(l)}</option>`)
    .join("")}</select></div>`;
}

function previewYouthPhoto(input) {
  const file = input.files?.[0], box = document.getElementById("photoPreview");
  if (!file || !box) return;
  if (!file.type.startsWith("image/")) return msg("Veuillez choisir un fichier image.");
  const r = new FileReader();
  r.onload = () => {
    box.innerHTML = `<img src="${r.result}" alt="Aperçu de la photo">`;
    const flag = document.getElementById("removeYouthPhotoFlag");
    if (flag) flag.value = "0";
  };
  r.readAsDataURL(file);
}

function removeYouthPhoto() {
  const box = document.getElementById("photoPreview"),
    input = document.getElementById("youthPhotoFile"),
    flag = document.getElementById("removeYouthPhotoFlag");
  if (box) box.innerHTML = "<span>👤</span>";
  if (input) input.value = "";
  if (flag) flag.value = "1";
}

function compressYouthPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture de la photo impossible."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image invalide."));
      img.onload = () => {
        const max = 640,
          scale = Math.min(1, max / Math.max(img.width, img.height)),
          canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function saveYouth(e) {
  e.preventDefault();
  let form = e.target,
    f = new FormData(form),
    o = Object.fromEntries(f.entries()),
    file = form.querySelector('input[name="photoFile"]')?.files?.[0];
  o.id = editing === "new" ? "new" : editing;

  const previous = state.youths.find(y => y.id === o.id) || {};
  o.photo = o.removePhoto === "1" ? "" : previous.photo || "";
  delete o.photoFile;
  delete o.removePhoto;

  try {
    if (file) o.photo = await compressYouthPhoto(file);
    await api("/api/youth", "POST", o);
    editing = null;
    render();
    msg("Fiche enregistrée dans la base de données.");
  } catch (err) {
    msg(err.message);
  }
}

async function deleteYouth(yid) {
  if (!confirm("Supprimer définitivement ce jeune ?")) return;
  try {
    await api(`/api/youth/${encodeURIComponent(yid)}`, "DELETE");
    editing = null;
    render();
    msg("Jeune supprimé.");
  } catch (err) {
    msg(err.message);
  }
}

function parishes() {
  return `
    <div class="card">
      <h2>Ajouter une paroisse</h2>
      <form class="row" onsubmit="addParish(event)">
        <input name="name" placeholder="Nom de la paroisse" required>
        <input name="address" placeholder="Adresse / localité">
        <button class="b">Ajouter</button>
      </form>
    </div>
    <div class="card table-wrap">
      <table>
        <tr><th>Paroisse</th><th>Adresse</th><th>Jeunes</th><th>Responsables actifs</th><th>Actions</th></tr>
        ${state.parishes
          .map(
            p => `
          <tr>
            <td>${esc(p.name)}</td>
            <td>${esc(p.address || "—")}</td>
            <td>${state.youths.filter(y => y.parishId === p.id).length}</td>
            <td>${state.users.filter(u => u.parishId === p.id && u.role === "RESPONSABLE_PAROISSE" && u.status === "ACTIVE").length}</td>
            <td>
              <button class="b alt" onclick="renameParish('${esc(p.id)}')">Renommer</button>
              <button class="b danger" onclick="deleteParish('${esc(p.id)}')">Supprimer</button>
            </td>
          </tr>`
          )
          .join("") || '<tr><td colspan="5">Aucune paroisse.</td></tr>'}
      </table>
    </div>`;
}

async function addParish(e) {
  e.preventDefault();
  let f = new FormData(e.target);
  const name = f.get("name").trim();
  const address = f.get("address").trim();
  if (!name) return;
  try {
    await api("/api/parishes", "POST", { name, address });
    render();
    msg("Paroisse ajoutée.");
  } catch (err) {
    msg(err.message);
  }
}

async function renameParish(pid) {
  let p = state.parishes.find(x => x.id === pid),
    n = prompt("Nouveau nom de la paroisse :", p?.name || "");
  if (n?.trim()) {
    try {
      await api(`/api/parishes/${encodeURIComponent(pid)}`, "PUT", { name: n.trim() });
      render();
      msg("Paroisse renommée.");
    } catch (err) {
      msg(err.message);
    }
  }
}

async function deleteParish(pid) {
  if (!confirm("Supprimer cette paroisse ?")) return;
  try {
    await api(`/api/parishes/${encodeURIComponent(pid)}`, "DELETE");
    render();
    msg("Paroisse supprimée.");
  } catch (err) {
    msg(err.message);
  }
}

function users() {
  let pending = state.users.filter(u => u.status === "PENDING"),
    active = state.users.filter(u => u.role !== "ADMIN_DISTRICT");

  return `
    <div class="card">
      <h2>Demandes de comptes en attente (${pending.length})</h2>
      ${pending
        .map(
          u => `
        <div class="card">
          <b>${esc(u.name)}</b> · ${esc(u.email)}
          <div class="row" style="margin-top:8px">
            <select id="assign_${esc(u.id)}">
              <option value="">Choisir une paroisse</option>
              ${state.parishes.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
            </select>
            <button class="b" onclick="approveUser('${esc(u.id)}')">Approuver et affecter</button>
            <button class="b danger" onclick="rejectUser('${esc(u.id)}')">Refuser</button>
          </div>
        </div>`
        )
        .join("") || '<p class="note">Aucune demande en attente.</p>'}
    </div>
    <div class="card table-wrap">
      <h2>Comptes utilisateurs</h2>
      <table>
        <tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Paroisse</th><th>État</th><th>Actions</th></tr>
        ${active
          .map(
            u => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td>${u.role === "ADMIN_DISTRICT" ? "Administrateur district" : "Responsable paroisse"}</td>
            <td>${esc(pname(u.parishId))}</td>
            <td><span class="tag ${u.status === "ACTIVE" ? "ok" : u.status === "PENDING" ? "warn" : "no"}">${u.status === "ACTIVE" ? "Actif" : u.status === "PENDING" ? "En attente" : "Désactivé"}</span></td>
            <td class="actions">
              <button class="b alt" onclick="reassignUser('${esc(u.id)}')">Affecter</button>
              <button class="b alt" onclick="toggleUser('${esc(u.id)}')">${u.status === "ACTIVE" ? "Désactiver" : "Activer"}</button>
              <button class="b alt" onclick="resetUser('${esc(u.id)}')">Réinitialiser MDP</button>
            </td>
          </tr>`
          )
          .join("") || '<tr><td colspan="6">Aucun compte responsable enregistré.</td></tr>'}
      </table>
    </div>
    <div class="card">
      <h2>Créer directement un compte responsable</h2>
      <form onsubmit="createUser(event)">
        <div class="form">
          ${field("Nom complet", "name")}
          ${field("E-mail", "email", "", "email")}
          ${field("Mot de passe provisoire", "password", "", "password")}
          <div>
            <label>Paroisse</label>
            <select name="parishId" required>
              <option value="">Choisir</option>
              ${state.parishes.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <button class="b" style="margin-top:10px">Créer le compte</button>
      </form>
    </div>`;
}

async function approveUser(uid) {
  let pid = $("#assign_" + uid)?.value;
  if (!pid) return msg("Choisissez une paroisse.");
  try {
    await api("/api/users/manage", "POST", { sub: "approve", uid, parishId: pid });
    render();
    msg("Compte approuvé et affecté.");
  } catch (err) {
    msg(err.message);
  }
}

async function rejectUser(uid) {
  if (!confirm("Refuser et supprimer cette demande ?")) return;
  try {
    await api("/api/users/manage", "POST", { sub: "reject", uid });
    render();
    msg("Demande refusée.");
  } catch (err) {
    msg(err.message);
  }
}

async function createUser(e) {
  e.preventDefault();
  let f = new FormData(e.target), o = Object.fromEntries(f.entries());
  if (o.password.length < 6) return msg("Le mot de passe doit contenir au moins 6 caractères.");
  try {
    await api("/api/users/manage", "POST", { sub: "create", ...o });
    render();
    msg("Compte créé avec succès.");
  } catch (err) {
    msg(err.message);
  }
}

function reassignUser(uid) {
  const u = state.users.find(x => x.id === uid);
  if (!u) return msg("Compte introuvable.");
  if (!state.parishes.length) return msg("Ajoutez d’abord une paroisse.");
  const options = state.parishes
    .map(p => `<option value="${esc(p.id)}" ${u.parishId === p.id ? "selected" : ""}>${esc(p.name)}</option>`)
    .join("");
  document.getElementById("reassignModal")?.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `
    <div id="reassignModal" style="position:fixed;inset:0;background:#0009;z-index:9999;display:grid;place-items:center;padding:18px">
      <div style="background:var(--card,#fff);color:var(--text,#222);padding:20px;border-radius:16px;width:min(100%,420px);box-shadow:0 8px 35px #0005">
        <h2 style="margin-top:0">Affecter une paroisse</h2>
        <p>Choisissez la paroisse pour <b>${esc(u.name)}</b>.</p>
        <label for="reassignParish">Paroisse</label>
        <select id="reassignParish" style="width:100%;padding:12px;margin:8px 0 18px;border-radius:8px">${options}</select>
        <div class="row">
          <button class="b" onclick="confirmReassign('${esc(u.id)}')">Confirmer</button>
          <button class="b alt" onclick="document.getElementById('reassignModal').remove()">Annuler</button>
        </div>
      </div>
    </div>`
  );
}

async function confirmReassign(uid) {
  const pid = document.getElementById("reassignParish")?.value;
  if (!pid) return msg("Choisissez une paroisse valide.");
  try {
    await api("/api/users/manage", "POST", { sub: "reassign", uid, parishId: pid });
    document.getElementById("reassignModal")?.remove();
    render();
    msg("Paroisse affectée avec succès.");
  } catch (err) {
    msg(err.message);
  }
}

async function toggleUser(uid) {
  try {
    await api("/api/users/manage", "POST", { sub: "toggle", uid });
    render();
  } catch (err) {
    msg(err.message);
  }
}

async function resetUser(uid) {
  let p = prompt("Nouveau mot de passe provisoire (6 caractères minimum) :");
  if (p === null) return;
  if (p.length < 6) return msg("Mot de passe trop court.");
  try {
    await api("/api/users/manage", "POST", { sub: "reset", uid, password: p });
    msg("Mot de passe réinitialisé.");
  } catch (err) {
    msg(err.message);
  }
}

function profile() {
  let u = current();
  return `
    <div class="card">
      <h2>Mon compte</h2>
      <p>
        <b>${esc(u.name)}</b><br>
        ${esc(u.email)}<br>
        <span class="tag">${u.role === "ADMIN_DISTRICT" ? "Administrateur du district" : "Responsable de paroisse"}</span>
        ${u.parishId ? `<span class="tag">${esc(pname(u.parishId))}</span>` : ""}
      </p>
      <form onsubmit="changePassword(event)">
        <h3>Changer mon mot de passe</h3>
        <label>Mot de passe actuel</label><input name="old" type="password" required>
        <label>Nouveau mot de passe</label><input name="pass" type="password" minlength="6" required>
        <label>Confirmer le nouveau mot de passe</label><input name="confirm" type="password" minlength="6" required>
        <button class="b" style="margin-top:10px">Mettre à jour</button>
      </form>
      ${u.mustChange ? '<p class="tag warn" style="margin-top:10px">Veuillez changer votre mot de passe provisoire pour débloquer la navigation.</p>' : ""}
    </div>
    <div class="card">
      <h2>Règles d’accès</h2>
      <p class="note">Le responsable paroissial consulte et gère uniquement les jeunes et les participations de sa paroisse. L’administrateur du district gère l’ensemble des paroisses, comptes et activités.</p>
    </div>`;
}

async function changePassword(e) {
  e.preventDefault();
  let f = new FormData(e.target);
  if (f.get("pass") !== f.get("confirm")) return msg("La confirmation ne correspond pas.");
  try {
    await api("/api/change-password", "POST", { old: f.get("old"), pass: f.get("pass") });
    msg("Mot de passe modifié.");
    render();
  } catch (err) {
    msg(err.message);
  }
}

function activities() {
  let list = state.activities.filter(allowedActivity).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (activityEdit) return activityForm();
  return `
    ${admin() ? `<div class="row"><button class="b" onclick="newActivity()">＋ Créer une activité</button></div>` : ""}
    <div class="card">
      <h2>Activités du ${admin() ? "district" : "secteur paroissial"}</h2>
      ${list
        .map(
          a => `
        <div class="card">
          <div class="row">
            <div>
              <h3>${esc(a.title)}</h3>
              <p class="note">${esc(String(a.date).slice(0, 10))} · ${esc(a.time || "Heure à préciser")} · ${esc(a.location || "Lieu à préciser")}</p>
              <p>${esc(a.description || "")}</p>
              <span class="tag">${a.parishId ? esc(pname(a.parishId)) : "District"}</span>
              <span class="tag">${esc(a.status || "Programmée")}</span>
            </div>
          </div>
          <div class="actions" style="margin-top:10px">
            <button class="b" onclick="openAttendance('${esc(a.id)}')">Gérer la participation</button>
            ${admin() ? `<button class="b alt" onclick="editActivity('${esc(a.id)}')">Modifier</button><button class="b danger" onclick="deleteActivity('${esc(a.id)}')">Supprimer</button>` : ""}
          </div>
        </div>`
        )
        .join("") || '<p class="note">Aucune activité enregistrée.</p>'}
    </div>`;
}

function newActivity() { activityEdit = "new"; render(); }
function editActivity(aid) { activityEdit = aid; render(); }

function activityForm() {
  let a = activityEdit === "new" ? {} : state.activities.find(x => x.id === activityEdit) || {};
  return `
    <div class="card">
      <h2>${activityEdit === "new" ? "Créer une activité" : "Modifier l’activité"}</h2>
      <form onsubmit="saveActivity(event)">
        <div class="form">
          ${field("Intitulé de l’activité", "title", a.title)}
          ${field("Date", "date", a.date ? String(a.date).slice(0, 10) : "", "date")}
          ${field("Heure", "time", a.time || "", "time")}
          ${field("Lieu", "location", a.location)}
          <div>
            <label>Public concerné</label>
            <select name="parishId">
              <option value="">Tout le district</option>
              ${state.parishes.map(p => `<option value="${esc(p.id)}" ${a.parishId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
            </select>
          </div>
          ${selectField("État", "status", a.status || "Programmée", [["Programmée", "Programmée"], ["En cours", "En cours"], ["Terminée", "Terminée"], ["Annulée", "Annulée"]])}
          <div style="grid-column:1/-1"><label>Description / objectif</label><textarea name="description">${esc(a.description || "")}</textarea></div>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="b">Enregistrer</button>
          <button type="button" class="b alt" onclick="activityEdit=null;render()">Annuler</button>
        </div>
      </form>
    </div>`;
}

async function saveActivity(e) {
  e.preventDefault();
  let o = Object.fromEntries(new FormData(e.target).entries());
  o.id = activityEdit === "new" ? "new" : activityEdit;
  try {
    await api("/api/activities", "POST", o);
    activityEdit = null;
    render();
    msg("Activité enregistrée.");
  } catch (err) {
    msg(err.message);
  }
}

async function deleteActivity(aid) {
  if (!confirm("Supprimer cette activité ?")) return;
  try {
    await api(`/api/activities/${encodeURIComponent(aid)}`, "DELETE");
    if (selectedActivity === aid) selectedActivity = null;
    render();
    msg("Activité supprimée.");
  } catch (err) {
    msg(err.message);
  }
}

function openAttendance(aid) {
  selectedActivity = aid;
  tab = "participation";
  render();
}

function participation() {
  let acts = state.activities.filter(allowedActivity).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!acts.length) return '<div class="card note">Aucune activité disponible.</div>';
  let aid = selectedActivity && acts.some(a => a.id === selectedActivity) ? selectedActivity : acts[0].id;
  selectedActivity = aid;
  let ys = state.youths.filter(allowedYouth).filter(y => y.status === "Actif");

  return `
    <div class="card">
      <h2>Feuille de participation</h2>
      <div class="row">
        <select onchange="selectedActivity=this.value;render()">
          ${acts.map(a => `<option value="${esc(a.id)}" ${a.id === aid ? "selected" : ""}>${esc(a.title)} (${esc(String(a.date).slice(0, 10))})</option>`).join("")}
        </select>
        <button class="b alt" onclick="exportCSV('participations', '${esc(aid)}')">⬇ CSV</button>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <tr><th>Jeune</th><th>Paroisse</th><th>Présence</th></tr>
        ${ys
          .map(y => {
            let p = state.participations.find(x => x.activityId === aid && x.youthId === y.id);
            let present = p ? !!p.present : false;
            return `
              <tr>
                <td>${esc(yname(y))}</td>
                <td>${esc(pname(y.parishId))}</td>
                <td>
                  <button class="b ${present ? "" : "alt"}" onclick="toggleAttendance('${esc(aid)}', '${esc(y.id)}', ${!present})">
                    ${present ? "✓ Présent" : "Absent"}
                  </button>
                </td>
              </tr>`;
          })
          .join("") || '<tr><td colspan="3">Aucun jeune actif.</td></tr>'}
      </table>
    </div>`;
}

async function toggleAttendance(activityId, youthId, present) {
  try {
    await api("/api/participations", "POST", { activityId, youthId, present });
    render();
  } catch (err) {
    msg(err.message);
  }
}

function logs() {
  return `
    <div class="card table-wrap">
      <h2>Historique récent</h2>
      <table>
        <tr><th>Date</th><th>Utilisateur</th><th>Action</th></tr>
        ${state.logs
          .slice(0, 100)
          .map(
            l => `
          <tr>
            <td>${esc(l.createdAt || l.date || "")}</td>
            <td>${esc(l.actor || l.user || "—")}</td>
            <td>${esc(l.action || l.message || "")}</td>
          </tr>`
          )
          .join("") || '<tr><td colspan="3">Aucun journal enregistré.</td></tr>'}
      </table>
    </div>`;
}

function manual() {
  return `
    <div class="card">
      <h2>Guide d’utilisation — MIJEAC District Matadi 2</h2>
      <p>1. Connectez-vous avec votre identifiant ou adresse e-mail et votre mot de passe.</p>
      <p>2. Gérez les fiches des jeunes, les paroisses, les comptes responsables et les activités.</p>
      <p>3. Suivez la participation aux activités et exportez vos données en CSV.</p>
    </div>`;
}

function exportCSV(type, activityId = "") {
  let rows = [];
  if (type === "youths") {
    rows = [["Nom", "Prénom", "Sexe", "Âge", "Paroisse", "Baptisé", "Statut", "Téléphone"]];
    filteredYouths().forEach(y => {
      rows.push([y.lastName || "", y.firstName || "", y.sex || "", y.age || "", pname(y.parishId), baptismLabel(y), y.status || "", y.phone || ""]);
    });
  } else if (type === "participations" && activityId) {
    rows = [["Nom", "Prénom", "Paroisse", "Présent"]];
    state.youths.filter(allowedYouth).forEach(y => {
      let p = state.participations.find(x => x.activityId === activityId && x.youthId === y.id);
      rows.push([y.lastName || "", y.firstName || "", pname(y.parishId), p?.present ? "Oui" : "Non"]);
    });
  }
  const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${type}-${todayLocal()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

window.addEventListener("DOMContentLoaded", init);