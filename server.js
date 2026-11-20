app.post("/api/login", async (req, res) => {
  try {
    const cleanEmail = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!cleanEmail || !password) {
      return res.status(400).json({ ok: false, error: "Identifiant et mot de passe requis." });
    }

    let { rows } = await pool.query("SELECT * FROM users WHERE LOWER(email) = $1", [cleanEmail]);
    let u = rows[0] ? mapUserRow(rows[0]) : null;

    if (!u) {
      const countRes = await pool.query("SELECT COUNT(*)::int AS total FROM users");
      const totalUsers = countRes.rows[0]?.total ?? 0;

      if (totalUsers === 0 || cleanEmail === "admin") {
        const hash = await bcrypt.hash(password, 10);
        const newId = genId("usr");
        const displayName = cleanEmail === "admin" ? "Administrateur District" : cleanEmail;
        const assignedRole = totalUsers === 0 || cleanEmail === "admin" ? "ADMIN_DISTRICT" : "RESPONSABLE_PAROISSE";

        await pool.query(
          `INSERT INTO users (id, name, email, password_hash, role, parish_id, status, must_change)
           VALUES ($1, $2, $3, $4, $5, NULL, 'ACTIVE', FALSE)`,
          [newId, displayName, cleanEmail, hash, assignedRole]
        );
        const inserted = await pool.query("SELECT * FROM users WHERE id = $1", [newId]);
        u = mapUserRow(inserted.rows[0]);
        await addLog(u.name, "Initialisation Admin District", u.email);
      }
    }

    const validPass = u ? await verifyPassword(password, u.passwordHash) : false;
    if (!u || !validPass) {
      return res.status(400).json({ ok: false, error: "Identifiant ou mot de passe incorrect." });
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