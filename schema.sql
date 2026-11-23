-- Base « bo-sup » — schéma Cloudflare D1 (exécuter une fois après création :
--   npx wrangler d1 execute bo-sup --remote --file=schema.sql)
CREATE TABLE IF NOT EXISTS appdata (
  scope   TEXT PRIMARY KEY,          -- activityId, entries, fdr, dmt, satcli, joign, meta
  payload TEXT NOT NULL,             -- contenu JSON
  updated TEXT NOT NULL              -- horodatage ISO du dernier envoi
);
CREATE TABLE IF NOT EXISTS planning_weeks (
  week    TEXT PRIMARY KEY,          -- clé de semaine (ex. « S48_2026 »)
  payload TEXT NOT NULL,             -- fiche complète de la semaine (JSON)
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS joign_rows (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL              -- une ligne brute de joignabilité (JSON) par rangée
);
