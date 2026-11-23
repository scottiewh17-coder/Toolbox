/* ============================================================
   _worker.js — Boîte à Outils Superviseur : site + API « base centrale »
   Mode avancé Cloudflare Pages : ce fichier est glissé-déposé À CÔTÉ
   de index.html (direct upload). Il répond :
   - tout ce qui n'est pas /api/*  ->  les fichiers du site (env.ASSETS)
   - GET  /api/state -> { ok, entries, weeks, joign, scopes, updated }
   - GET  /api/pull  -> { ok, dump: {base complète} }
   - POST /api/push  -> { ok, entries, weeks, joign }   (remplacement complet)
   Configuration à faire dans le tableau de bord Cloudflare (sans GitHub,
   sans installer de logiciel) — guide DEPLOY-D1.md livré avec l'application :
   1) Créer la base D1 « bo-sup » + coller schema.sql dans sa console.
   2) Pages → Settings → Bindings : liaison D1 nommée « DB » → bo-sup.
   3) (Conseillé) Pages → Settings → Variables : APP_KEY = mot de passe ;
      le même mot de passe se saisit dans l'outil (carte « Base centrale »).
   ============================================================ */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,X-App-Key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Cache-Control": "no-store"
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json;charset=utf-8" }, CORS)
  });
}
function bad(msg, status) { return json({ ok: false, error: msg }, status || 400); }

async function handleApi(request, env, url) {
  if (!env.APP_KEY || request.headers.get("X-App-Key") === env.APP_KEY ||
      url.searchParams.get("key") === env.APP_KEY) {
    /* autorisé (ou aucune clé définie côté Cloudflare) */
  } else {
    return bad("unauthorized", 401);
  }
  const db = env.DB;
  if (!db) return bad("D1 non configuré (binding DB absent) — voir DEPLOY-D1.md, étape 3", 200);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const now = new Date().toISOString();

  try {
    /* ---- État (détection + compteurs) ---- */
    if (request.method === "GET" && route === "state") {
      const out = await db.batch([
        db.prepare("SELECT COUNT(*) AS n FROM appdata"),
        db.prepare("SELECT COUNT(*) AS n FROM planning_weeks"),
        db.prepare("SELECT COUNT(*) AS n FROM joign_rows"),
        db.prepare("SELECT MAX(updated) AS u FROM appdata"),
        db.prepare("SELECT payload FROM appdata WHERE scope = 'entries'")
      ]);
      const entriesPayload = out[4].results[0] ? out[4].results[0].payload : null;
      let entries = 0;
      if (entriesPayload) { try { entries = JSON.parse(entriesPayload).length; } catch (e) { entries = 0; } }
      return json({
        ok: true, scopes: out[0].results[0].n, weeks: out[1].results[0].n,
        joign: out[2].results[0].n, updated: out[3].results[0].u || null, entries: entries
      });
    }

    /* ---- Récupération complète ---- */
    if (request.method === "GET" && route === "pull") {
      const out = await db.batch([
        db.prepare("SELECT scope, payload FROM appdata"),
        db.prepare("SELECT payload FROM planning_weeks ORDER BY week"),
        db.prepare("SELECT payload FROM joign_rows ORDER BY id")
      ]);
      const appdata = {};
      for (const row of out[0].results) {
        try { appdata[row.scope] = JSON.parse(row.payload); } catch (e) { /* ligne corrompue ignorée */ }
      }
      const planning = [];
      for (const row of out[1].results) { try { planning.push(JSON.parse(row.payload)); } catch (e) { } }
      const joignRaw = [];
      for (const row of out[2].results) { try { joignRaw.push(JSON.parse(row.payload)); } catch (e) { } }
      return json({
        ok: true,
        dump: {
          app: "boite-outils-superviseur", version: 3, exported: now,
          activityId: appdata.activityId || null,
          entries: appdata.entries || [],
          fdr: appdata.fdr || [],
          dmt: appdata.dmt || null,
          satcli: appdata.satcli || null,
          joign: appdata.joign || null,
          savedAt: appdata.meta ? appdata.meta.savedAt : null,
          planning: planning, joignRaw: joignRaw
        }
      });
    }

    /* ---- Envoi complet (remplacement) ---- */
    if (request.method === "POST" && route === "push") {
      let body;
      try { body = await request.json(); } catch (e) { return bad("corps JSON illisible"); }
      if (!body || !Array.isArray(body.entries)) return bad("format attendu : { entries: [...] }");
      const planning = Array.isArray(body.planning) ? body.planning.filter(r => r && r.week) : [];
      const joignRaw = Array.isArray(body.joignRaw) ? body.joignRaw.filter(Boolean) : [];
      if (joignRaw.length > 50000) return bad("trop de lignes joignabilité (" + joignRaw.length + ") — purgez d'abord les anciens mois");

      /* Référentiels et saisies : une ligne par scope. */
      const scopes = {
        activityId: body.activityId || null,
        entries: body.entries,
        fdr: Array.isArray(body.fdr) ? body.fdr : [],
        dmt: body.dmt || {},
        satcli: body.satcli || {},
        joign: body.joign || {},
        meta: { savedAt: (body.exported || now), exported: body.exported || now }
      };
      const stmts = [
        db.prepare("DELETE FROM appdata"),
        db.prepare("DELETE FROM planning_weeks"),
        db.prepare("DELETE FROM joign_rows")
      ];
      for (const scope of Object.keys(scopes)) {
        stmts.push(db.prepare("INSERT INTO appdata (scope, payload, updated) VALUES (?, ?, ?)")
          .bind(scope, JSON.stringify(scopes[scope]), now));
      }
      for (const rec of planning) {
        stmts.push(db.prepare("INSERT INTO planning_weeks (week, payload, updated) VALUES (?, ?, ?)")
          .bind(String(rec.week), JSON.stringify(rec), now));
      }
      await db.batch(stmts);
      /* Lignes brutes : lots de 100 requêtes (limite pratique D1). */
      for (let i = 0; i < joignRaw.length; i += 100) {
        const chunk = joignRaw.slice(i, i + 100).map(r =>
          db.prepare("INSERT INTO joign_rows (payload) VALUES (?)").bind(JSON.stringify(r)));
        await db.batch(chunk);
      }
      return json({ ok: true, entries: body.entries.length, weeks: planning.length, joign: joignRaw.length, updated: now });
    }

    return bad("route inconnue : /api/" + route, 404);
  } catch (e) {
    return bad("erreur serveur : " + (e && e.message ? e.message : "inconnue"), 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      return handleApi(request, env, url);
    }
    /* Site statique : index.html, logos... servis par les Pages Assets. */
    return env.ASSETS.fetch(request);
  }
};
