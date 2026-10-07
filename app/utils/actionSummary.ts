/**
 * Récapitulatif lisible d'une action d'écriture, pour la carte de confirmation : un titre, une phrase qui dit
 * ce qui va se passer, puis des blocs d'informations présentés comme sur une fiche (sans noms de champs techniques).
 */
export interface ActionSummary {
  title: string;
  description: string;
  sections: { label: string; lines: string[] }[];
  /** Action irréversible ou sensible : la carte est mise en évidence. */
  danger?: boolean;
}

type Input = Record<string, any>;

const texts = {
  fr: {
    cancelTitle: "Annuler la commande",
    cancelText: (id: string) => `Tous les articles de la commande ${id} seront annulés. Les articles déjà préparés ou expédiés ne pourront peut-être pas l'être.`,
    stateTitle: "Changer le statut de la commande",
    stateText: (id: string, from: string, to: string) => `La commande ${id} passera du statut « ${from} » au statut « ${to} ».`,
    updateTitle: "Modifier la commande",
    updateText: (id: string) => `Les informations ci-dessous remplaceront celles de la commande ${id}.`,
    itemsTitle: "Changer le statut d'articles",
    itemsText: (id: string, items: string, from: string | undefined, to: string) =>
      from
        ? `${items} de la commande ${id} passeront du statut « ${from} » au statut « ${to} ».`
        : `${items} de la commande ${id} passeront au statut « ${to} ».`,
    item: (n: number) => `L'article n° ${n}`,
    items: (list: string) => `Les articles n° ${list}`,
    and: "et",
    customer: "Client",
    shipping: "Adresse de livraison (envoi du colis)",
    billing: "Adresse de facturation (sur la facture)",
    shippingContact: "Destinataire du colis",
    billingContact: "Contact de facturation",
    information: "Informations complémentaires",
    signature: "Signature au retrait",
    yes: "Oui, signature demandée au client",
    no: "Non",
    location: "Point de stock",
    removed: "annulé",
  },
  en: {
    cancelTitle: "Cancel the order",
    cancelText: (id: string) => `All items of order ${id} will be cancelled. Items already prepared or shipped may not be cancellable.`,
    stateTitle: "Change the order status",
    stateText: (id: string, from: string, to: string) => `Order ${id} will move from status “${from}” to status “${to}”.`,
    updateTitle: "Update the order",
    updateText: (id: string) => `The information below will replace the current information of order ${id}.`,
    itemsTitle: "Change the status of items",
    itemsText: (id: string, items: string, from: string | undefined, to: string) =>
      from
        ? `${items} of order ${id} will move from status “${from}” to status “${to}”.`
        : `${items} of order ${id} will move to status “${to}”.`,
    item: (n: number) => `Item #${n}`,
    items: (list: string) => `Items #${list}`,
    and: "and",
    customer: "Customer",
    shipping: "Shipping address (where the parcel goes)",
    billing: "Billing address (on the invoice)",
    shippingContact: "Parcel recipient",
    billingContact: "Billing contact",
    information: "Additional information",
    signature: "Signature on collection",
    yes: "Yes, the customer must sign",
    no: "No",
    location: "Stock location",
    removed: "cancelled",
  },
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

/** « M. Julien Moreau », email et téléphone sur des lignes séparées. */
function personLines(p: Input | undefined): string[] {
  if (!p || typeof p !== "object") return [];
  const name = [p.title, p.first_name, p.last_name].map(clean).filter(Boolean).join(" ");
  return [name, clean(p.email), clean(p.phone_number)].filter(Boolean);
}

function samePerson(a: Input | undefined, b: Input | undefined): boolean {
  return JSON.stringify(personLines(a)) === JSON.stringify(personLines(b));
}

function countryName(code: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Plages d'index (base 0) → « n° 1, 2 et 3 » (numérotation à partir de 1). */
function itemNumbers(ranges: unknown, t: (typeof texts)["fr"]): string {
  const numbers: number[] = [];
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const from = Number(r?.from);
    const to = Number(r?.to ?? r?.from);
    if (Number.isFinite(from) && Number.isFinite(to)) for (let i = Math.min(from, to); i <= Math.max(from, to); i++) numbers.push(i + 1);
  }
  if (numbers.length === 1) return t.item(numbers[0]!);
  const list = numbers.length > 1 ? `${numbers.slice(0, -1).join(", ")} ${t.and} ${numbers.at(-1)}` : "?";
  return t.items(list);
}

const stateLabel = (state: string, t: (typeof texts)["fr"]) => (state === "removed" ? t.removed : state);

export function summarizeAction(name: string, input: Input, lang?: string): ActionSummary {
  const code = lang?.toLowerCase().startsWith("fr") ? "fr" : "en";
  const t = texts[code];
  const id = clean(input.order_id);

  switch (name) {
    case "cancel_order":
      return { title: t.cancelTitle, description: t.cancelText(id), sections: [], danger: true };

    case "update_order_state":
      return {
        title: t.stateTitle,
        description: t.stateText(id, stateLabel(clean(input.from), t), stateLabel(clean(input.to), t)),
        sections: [],
        danger: input.to === "removed" || /cancel/i.test(clean(input.to)),
      };

    case "update_line_item_groups_state":
      return {
        title: t.itemsTitle,
        description: t.itemsText(
          id,
          itemNumbers(input.index_ranges, t),
          input.from ? stateLabel(clean(input.from), t) : undefined,
          stateLabel(clean(input.to), t),
        ),
        sections: input.endpoint_id ? [{ label: t.location, lines: [clean(input.endpoint_id)] }] : [],
        danger: input.to === "removed",
      };

    case "update_order": {
      const sections: ActionSummary["sections"] = [];
      const customer = personLines(input.customer);
      if (customer.length) sections.push({ label: t.customer, lines: customer });
      const addAddress = (a: Input | undefined, label: string, contactLabel: string) => {
        if (!a || typeof a !== "object") return;
        const lines = [
          ...(Array.isArray(a.lines) ? a.lines.map(clean).filter(Boolean) : []),
          [clean(a.zip_code), clean(a.city)].filter(Boolean).join(" "),
          a.country_code ? countryName(clean(a.country_code), code) : "",
        ].filter(Boolean);
        sections.push({ label, lines });
        // Personne à l'adresse affichée seulement si elle diffère du client modifié.
        if (a.contact && !samePerson(a.contact, input.customer)) {
          const person = personLines(a.contact);
          if (person.length) sections.push({ label: contactLabel, lines: person });
        }
      };
      addAddress(input.shipping_address ?? input.delivery_address, t.shipping, t.shippingContact);
      addAddress(input.billing_address, t.billing, t.billingContact);
      if (input.information && typeof input.information === "object") {
        const lines = Object.entries(input.information as Record<string, unknown>)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k.replace(/_/g, " ")} : ${typeof v === "object" ? JSON.stringify(v) : v}`);
        if (lines.length) sections.push({ label: t.information, lines });
      }
      if (typeof input.sign_on_collect === "boolean") {
        sections.push({ label: t.signature, lines: [input.sign_on_collect ? t.yes : t.no] });
      }
      return { title: t.updateTitle, description: t.updateText(id), sections };
    }

    default:
      return { title: name, description: "", sections: [] };
  }
}
