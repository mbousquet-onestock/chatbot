import { requireSession } from "../../utils/session";
import { testConnections, type SettingsFormValues } from "../../utils/settingsForm";

/** Teste les connexions avec les valeurs saisies dans l'onglet Paramètres, sans rien enregistrer. */
export default defineEventHandler(async (event) => {
  const session = requireSession(event);
  const body = await readBody<{ values?: SettingsFormValues }>(event);
  return { tests: await testConnections(session.siteId, body?.values ?? {}) };
});
