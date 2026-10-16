import { requireSession } from "../../utils/session";
import { EDITABLE_KEYS, clearSettingsCache, normalizeApiRoot, writeSetting, type EditableKey } from "../../utils/settings";
import { checkAdminPassword, resolveCandidate, type SettingsFormValues } from "../../utils/settingsForm";

interface SaveBody {
  values?: SettingsFormValues;
  /** Portée : ce site (site_id du contexte) ou tous les sites (site_id vide = global). */
  scope?: "site" | "global";
  environment?: string;
  admin_password?: string;
}

/** Enregistre les valeurs saisies dans la table settings (mot de passe administrateur requis). */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const body = (await readBody<SaveBody>(event)) ?? {};
  checkAdminPassword(body.admin_password);

  const environment = body.environment?.trim();
  if (!environment) throw createError({ statusCode: 400, statusMessage: "missing_environment" });
  const siteId = body.scope === "global" ? "" : session.siteId;
  const values = body.values ?? {};
  // Refuse une nouvelle URL d'API sans nouveau token (le token enregistré ne doit pas partir ailleurs).
  await resolveCandidate(session.siteId, values);

  const saved: { key: EditableKey; result: "updated" | "inserted" }[] = [];
  for (const key of EDITABLE_KEYS) {
    const raw = typeof values[key] === "string" ? values[key]!.trim() : "";
    if (!raw) continue;
    // Le token est chiffré par writeSetting (ou par l'API Settings).
    const value = key === "onestock_api_root" ? normalizeApiRoot(raw) : raw;
    try {
      saved.push({ key, result: await writeSetting(key, value, siteId, environment) });
    } catch (err) {
      console.error("[settings] write failed", key, err);
      throw createError({
        statusCode: 500,
        statusMessage: `settings_write_error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        data: { saved },
      });
    }
  }
  clearSettingsCache();
  console.info("[settings] saved", { site_id: siteId, environment, keys: saved.map((s) => s.key), by: session.userId || null });
  return { saved, site_id: siteId, environment };
});
