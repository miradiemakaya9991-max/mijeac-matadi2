require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true, limit: "6mb" }));
app.use(express.static(path.join(__dirname)));

if (!process.env.DATABASE_URL) {
  console.error("Erreur : DATABASE_URL est manquant.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sessions = new Map();
const genId = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function normalizeParishId(val) {
  const s = String(val || "").trim();
  return s ? s : null;
}

function mapUserRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    parishId: row.parish_id || "",
    status: row.status,
    mustChange: Boolean(row.must_change),
    createdAt: row.created_at
  };
}

function sanitizeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    parishId: u.parishId || "",
    status: u.status,
    mustChange: Boolean(u.mustChange),
    createdAt: u.createdAt
  };
}

async function verifyPassword(plain, storedHash) {
  if (!plain || !storedHash) return false;
  if (storedHash.startsWith("$2a$") || storedHash.startsWith("$2b$") || storedHash.startsWith("$2y$")) {
    return bcrypt.compare(plain, storedHash);
  }
  return plain === storedHash;
}

async function addLog(userName, action, detail = "") {
  try {
    await pool.query(
      `INSERT INTO logs (id, log_date, user_name, action, detail)
       VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4)`,
      [genId("log"), userName, action, String(detail || "").slice(0, 255)]
    );
  } catch (err) {
    console.error("Erreur ajout log:", err.message);
  }
}

async function ensureSeedData() {
  await pool.query(
    `INSERT INTO parishes (id, name, address)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    ["p_matadi_centre", "Paroisse Centrale", "Matadi 2"]
  );
}

async function getAuthUser(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const uid = sessions.get(token);
  if (!uid) return null;

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [uid]);
  if (!rows[0]) return null;
  const u = mapUserRow(rows[0]);
  if (u.status !== "ACTIVE") return null;
  return u;
}

async function buildState(me) {
  const isAdmin = me.role === "ADMIN_DISTRICT";
  const pid = me.parishId || "";

  const parishesRes = await pool.query("SELECT id, name, address FROM parishes ORDER BY name ASC");
  const parishes = parishesRes.rows;

  const youthsRes = isAdmin
    ? await pool.query("SELECT * FROM youths ORDER BY created_at DESC")
    : await pool.query("SELECT * FROM youths WHERE parish_id = $1 ORDER BY created_at DESC", [pid]);

  const youths = youthsRes.rows.map(y => ({
    id: y.id,
    lastName: y.last_name,
    firstName: y.first_name,
    sex: y.sex || "",
    age: y.age,
    phone: y.phone || "",
    email: y.email || "",
    address: y.address || "",
    studies: y.studies || "",
    churchRole: y.church_role || "",
    situation: y.situation || "",
    parishId: y.parish_id || "",
    status: y.status || "Actif",
    baptized: y.baptized || "Non",
    photo: y.photo || ""
  }));

  const activitiesRes = isAdmin
    ? await pool.query("SELECT * FROM activities ORDER BY activity_date DESC")
    : await pool.query(
        "SELECT * FROM activities WHERE parish_id IS NULL OR parish_id = $1 ORDER BY activity_date DESC",
        [pid]
      );

  const activities = activitiesRes.rows.map(a => ({
    id: a.id,
    title: a.title,
    date: a.activity_date instanceof Date ? a.activity_date.toISOString().slice(0, 10) : String(a.activity_date || "").slice(0, 10),
    time: a.activity_time || "",
    location: a.location || "",
    parishId: a.parish_id || "",
    status: a.status || "Programmée",
    description: a.description || ""
  }));

  const users = isAdmin
    ? (await pool.query("SELECT * FROM users ORDER BY created_at DESC")).rows.map(r => sanitizeUser(mapUserRow(r)))
    : [sanitizeUser(me)];

  const participations = (await pool.query("SELECT * FROM participations ORDER BY updated_at DESC")).rows.map(p => ({
    id: p.id,
    activityId: p.activity_id,
    youthId: p.youth_id,
    status: p.status || "",
    note: p.note || "",
    updatedAt: p.updated_at
  }));

  const logs = isAdmin
    ? (await pool.query("SELECT * FROM logs ORDER BY log_date DESC LIMIT 500")).rows.map(l => ({
        id: l.id,
        date: l.log_date,
        user: l.user_name,
        action: l.action,
        detail: l.detail || ""
      }))
    : [];

  return { users, parishes, youths, activities, participations, logs };
}

app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() AS now");
    res.json({ ok: true, dbTime: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const cleanEmail = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const { rows } = await pool.query("SELECT * FROM users WHERE LOWER(email) = $1", [cleanEmail]);
    const u = rows[0] ? mapUserRow(rows[0]) : null;

    const validPass = u ? await verifyPassword(password, u.passwordHash) : false;
    if (!u || !validPass) {
      return res.status(400).json({ ok: false, error: "E-mail ou mot de passe incorrect." });
    }
    if (u.status !== "ACTIVE") {
      return res.status(400).json({
        ok: false,
        error: u.status === "PENDING" ? "Votre demande est encore en attente." : "Ce compte est désactivé."
      });
    }

    const token = genId("tok");
    sessions.set(token, u.id);
    await addLog(u.name, "Connexion", u.email);

    const me = sanitizeUser(u);
    res.json({ ok: true, token, me, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const cleanEmail = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !cleanEmail || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Champs invalides." });
    }
    const exists = await pool.query("SELECT 1 FROM users WHERE LOWER(email) = $1", [cleanEmail]);
    if (exists.rowCount > 0) {
      return res.status(400).json({ ok: false, error: "Cette adresse e-mail existe déjà." });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, parish_id, status, must_change)
       VALUES ($1, $2, $3, $4, 'RESPONSABLE_PAROISSE', NULL, 'PENDING', FALSE)`,
      [genId("usr"), name, cleanEmail, hash]
    );
    await addLog(name, "Demande de compte", cleanEmail);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/logout", (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/state", async (req, res) => {
  const u = await getAuthUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "Session expirée." });
  const me = sanitizeUser(u);
  res.json({ ok: true, me, state: await buildState(me) });
});

app.post("/api/change-password", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u) return res.status(401).json({ ok: false, error: "Session expirée." });

    const oldPass = String(req.body.old || "");
    const newPass = String(req.body.pass || "");
    if (!(await verifyPassword(oldPass, u.passwordHash))) {
      return res.status(400).json({ ok: false, error: "Mot de passe actuel incorrect." });
    }
    if (newPass.length < 6) {
      return res.status(400).json({ ok: false, error: "Minimum 6 caractères." });
    }

    const newHash = await bcrypt.hash(newPass, 10);
    await pool.query(
      "UPDATE users SET password_hash = $1, must_change = FALSE WHERE id = $2",
      [newHash, u.id]
    );
    await addLog(u.name, "Changement de mot de passe", u.email);

    const updated = mapUserRow((await pool.query("SELECT * FROM users WHERE id = $1", [u.id])).rows[0]);
    const me = sanitizeUser(updated);
    res.json({ ok: true, me, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/youth", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u) return res.status(401).json({ ok: false, error: "Session expirée." });

    const y = req.body || {};
    const isAdmin = u.role === "ADMIN_DISTRICT";
    const pid = isAdmin ? String(y.parishId || "").trim() : String(u.parishId || "").trim();
    const lastName = String(y.lastName || "").trim();
    const firstName = String(y.firstName || "").trim();

    if (!lastName || !firstName || !pid) {
      return res.status(400).json({ ok: false, error: "Nom, prénom et paroisse sont obligatoires." });
    }

    const isNew = !y.id || y.id === "new";
    const id = isNew ? genId("y") : y.id;
    const age = y.age !== undefined && y.age !== null && String(y.age).trim() !== ""
      ? parseInt(y.age, 10)
      : null;

    await pool.query(
      `INSERT INTO youths (
        id, last_name, first_name, sex, age, phone, email, address, studies,
        church_role, situation, parish_id, status, baptized, photo
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        last_name = EXCLUDED.last_name,
        first_name = EXCLUDED.first_name,
        sex = EXCLUDED.sex,
        age = EXCLUDED.age,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        address = EXCLUDED.address,
        studies = EXCLUDED.studies,
        church_role = EXCLUDED.church_role,
        situation = EXCLUDED.situation,
        parish_id = EXCLUDED.parish_id,
        status = EXCLUDED.status,
        baptized = EXCLUDED.baptized,
        photo = EXCLUDED.photo`,
      [
        id, lastName, firstName, y.sex || "", Number.isNaN(age) ? null : age,
        y.phone || "", y.email || "", y.address || "", y.studies || "",
        y.churchRole || "", y.situation || "", pid,
        y.status || "Actif", y.baptized || "Non", y.photo || ""
      ]
    );

    await addLog(u.name, isNew ? "Ajout d’un jeune" : "Modification d’un jeune", `${lastName} ${firstName}`);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur lors de l'enregistrement du jeune." });
  }
});

app.delete("/api/youth/:id", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }
    await pool.query("DELETE FROM participations WHERE youth_id = $1", [req.params.id]);
    await pool.query("DELETE FROM youths WHERE id = $1", [req.params.id]);
    await addLog(u.name, "Suppression d’un jeune", req.params.id);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/parishes", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }
    const name = String(req.body.name || "").trim();
    const address = String(req.body.address || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Nom requis." });

    await pool.query("INSERT INTO parishes (id, name, address) VALUES ($1, $2, $3)", [genId("p"), name, address]);
    await addLog(u.name, "Ajout d’une paroisse", name);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.put("/api/parishes/:id", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }
    const { rows } = await pool.query("SELECT * FROM parishes WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Paroisse introuvable." });

    const newName = String(req.body.name || rows[0].name).trim();
    await pool.query("UPDATE parishes SET name = $1 WHERE id = $2", [newName, req.params.id]);
    await addLog(u.name, "Renommage d’une paroisse", newName);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.delete("/api/parishes/:id", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }
    const yCount = await pool.query("SELECT 1 FROM youths WHERE parish_id = $1 LIMIT 1", [req.params.id]);
    const uCount = await pool.query("SELECT 1 FROM users WHERE parish_id = $1 AND status = 'ACTIVE' LIMIT 1", [req.params.id]);
    if (yCount.rowCount > 0 || uCount.rowCount > 0) {
      return res.status(400).json({ ok: false, error: "Impossible : cette paroisse possède encore des jeunes ou des responsables." });
    }
    await pool.query("DELETE FROM parishes WHERE id = $1", [req.params.id]);
    await addLog(u.name, "Suppression d’une paroisse", req.params.id);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/users/manage", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }

    const { sub, uid, parishId, password, name, email } = req.body || {};
    const targetRes = await pool.query("SELECT * FROM users WHERE id = $1", [uid]);
    const target = targetRes.rows[0] ? mapUserRow(targetRes.rows[0]) : null;
    const pid = normalizeParishId(parishId);

    if (sub === "approve" && target) {
      await pool.query(
        "UPDATE users SET parish_id = $1, status = 'ACTIVE', must_change = TRUE WHERE id = $2",
        [pid, uid]
      );
      await addLog(u.name, "Approbation d’un compte", target.email);
    } else if (sub === "reject") {
      await pool.query("DELETE FROM users WHERE id = $1 AND status = 'PENDING'", [uid]);
      await addLog(u.name, "Refus d’une demande", uid);
    } else if (sub === "reassign" && target) {
      await pool.query("UPDATE users SET parish_id = $1 WHERE id = $2", [pid, uid]);
      await addLog(u.name, "Réaffectation d’un compte", target.email);
    } else if (sub === "toggle" && target) {
      const nextStatus = target.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
      await pool.query("UPDATE users SET status = $1 WHERE id = $2", [nextStatus, uid]);
      await addLog(u.name, "Changement statut compte", target.email);
    } else if (sub === "reset" && target) {
      const hash = await bcrypt.hash(String(password || "123456"), 10);
      await pool.query(
        "UPDATE users SET password_hash = $1, must_change = TRUE WHERE id = $2",
        [hash, uid]
      );
      await addLog(u.name, "Réinitialisation MDP", target.email);
    } else if (sub === "create") {
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanName = String(name || "").trim();
      if (!cleanName || !cleanEmail || String(password || "").length < 6) {
        return res.status(400).json({ ok: false, error: "Informations de compte invalides." });
      }
      const dup = await pool.query("SELECT 1 FROM users WHERE LOWER(email) = $1", [cleanEmail]);
      if (dup.rowCount > 0) {
        return res.status(400).json({ ok: false, error: "Cet e-mail existe déjà." });
      }
      const hash = await bcrypt.hash(String(password), 10);
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, role, parish_id, status, must_change)
         VALUES ($1, $2, $3, $4, 'RESPONSABLE_PAROISSE', $5, 'ACTIVE', TRUE)`,
        [genId("usr"), cleanName, cleanEmail, hash, pid]
      );
      await addLog(u.name, "Création d’un compte", cleanEmail);
    }

    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/activities", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }
    const a = req.body || {};
    const title = String(a.title || "").trim();
    const actDate = String(a.date || "").trim();
    if (!title || !actDate) {
      return res.status(400).json({ ok: false, error: "Intitulé et date obligatoires." });
    }

    const isNew = !a.id || a.id === "new";
    const id = isNew ? genId("act") : a.id;
    const pid = normalizeParishId(a.parishId);

    await pool.query(
      `INSERT INTO activities (
        id, title, activity_date, activity_time, location, parish_id, status, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        activity_date = EXCLUDED.activity_date,
        activity_time = EXCLUDED.activity_time,
        location = EXCLUDED.location,
        parish_id = EXCLUDED.parish_id,
        status = EXCLUDED.status,
        description = EXCLUDED.description`,
      [id, title, actDate, a.time || "", a.location || "", pid, a.status || "Programmée", a.description || ""]
    );

    await addLog(u.name, isNew ? "Création d’une activité" : "Modification d’une activité", title);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur lors de l'enregistrement de l'activité." });
  }
});

app.delete("/api/activities/:id", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u || u.role !== "ADMIN_DISTRICT") {
      return res.status(403).json({ ok: false, error: "Accès refusé." });
    }
    await pool.query("DELETE FROM participations WHERE activity_id = $1", [req.params.id]);
    await pool.query("DELETE FROM activities WHERE id = $1", [req.params.id]);
    await addLog(u.name, "Suppression d’une activité", req.params.id);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/attendance", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u) return res.status(401).json({ ok: false, error: "Session expirée." });

    const { activityId, youthId, status, note } = req.body || {};
    const existingRes = await pool.query(
      "SELECT * FROM participations WHERE activity_id = $1 AND youth_id = $2",
      [activityId, youthId]
    );
    const cur = existingRes.rows[0];
    const nextStatus = status !== undefined ? String(status) : (cur ? cur.status : "");
    const nextNote = note !== undefined ? String(note).trim() : (cur ? cur.note : "");

    await pool.query(
      `INSERT INTO participations (id, activity_id, youth_id, status, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (activity_id, youth_id) DO UPDATE SET
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         updated_at = CURRENT_TIMESTAMP`,
      [cur ? cur.id : genId("part"), activityId, youthId, nextStatus, nextNote]
    );

    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

app.post("/api/attendance/bulk", async (req, res) => {
  try {
    const u = await getAuthUser(req);
    if (!u) return res.status(401).json({ ok: false, error: "Session expirée." });

    const { activityId, status } = req.body || {};
    const actRes = await pool.query("SELECT * FROM activities WHERE id = $1", [activityId]);
    const act = actRes.rows[0];
    if (!act) return res.status(404).json({ ok: false, error: "Activité introuvable." });

    const allYouths = (await pool.query("SELECT * FROM youths WHERE status = 'Actif'")).rows;
    const eligible = allYouths.filter(y => {
      if (u.role !== "ADMIN_DISTRICT" && y.parish_id !== u.parishId) return false;
      if (act.parish_id && y.parish_id !== act.parish_id) return false;
      return true;
    });

    for (const y of eligible) {
      const ex = await pool.query(
        "SELECT id FROM participations WHERE activity_id = $1 AND youth_id = $2",
        [activityId, y.id]
      );
      await pool.query(
        `INSERT INTO participations (id, activity_id, youth_id, status, note, updated_at)
         VALUES ($1, $2, $3, $4, '', CURRENT_TIMESTAMP)
         ON CONFLICT (activity_id, youth_id) DO UPDATE SET
           status = EXCLUDED.status,
           updated_at = CURRENT_TIMESTAMP`,
        [ex.rows[0] ? ex.rows[0].id : genId("part"), activityId, y.id, String(status || "")]
      );
    }

    await addLog(u.name, "Pointage groupé", `${act.title} → ${status}`);
    const me = sanitizeUser(u);
    res.json({ ok: true, state: await buildState(me) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erreur serveur." });
  }
});

const PORT = process.env.PORT || 3000;
ensureSeedData()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Serveur MIJEAC connecté à PostgreSQL sur le port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Erreur d'initialisation PostgreSQL :", err);
    process.exit(1);
  });