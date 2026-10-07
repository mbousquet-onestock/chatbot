type Address = Record<string, any>;

/** Éléments manquants d'une adresse saisie (rue, code postal, ville, pays). */
export function missingAddressParts(a: Address | undefined): string[] {
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const missing: string[] = [];
  if (!a || !Array.isArray(a.lines) || !a.lines.some(filled)) missing.push("numéro et rue");
  if (!filled(a?.zip_code)) missing.push("code postal");
  if (!filled(a?.city)) missing.push("ville");
  if (!filled(a?.country_code)) missing.push("pays");
  return missing;
}

/** Même adresse (rue, code postal, ville, pays), sans tenir compte de la casse ni des espaces. */
export function sameAddress(existing: Address, proposed: Address): boolean {
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const lines = (v: unknown) => (Array.isArray(v) ? v.map(norm).filter(Boolean).join("|") : "");
  return (
    lines(existing.lines) === lines(proposed.lines) &&
    norm(existing.zip_code) === norm(proposed.zip_code) &&
    norm(existing.city) === norm(proposed.city) &&
    norm(existing.regions?.country?.code ?? existing.country_code) === norm(proposed.country_code)
  );
}
