"""Génère server/data/onestock-api.json à partir de la spécification OpenAPI OneStock (YAML).

Usage : python3 scripts/build_api_catalog.py chemin/vers/APIInterneOneStock.yaml

Le catalogue garde, pour chaque opération : méthode, chemin, version, catégorie, résumé, schéma du corps
(référence) et un exemple ; et les schémas référencés, allégés (descriptions raccourcies, extensions x-* retirées).
"""
import json
import re
import sys

import yaml

METHODS = ("get", "post", "put", "patch", "delete")
MAX_DESCRIPTION = 400
MAX_SUMMARY = 220
MAX_EXAMPLE = 4000


def short(text, limit):
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def slim(node):
    """Schéma allégé : descriptions courtes, sans clés x-*, exemples ni titres."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k.startswith("x-") or k in ("example", "examples", "title"):
                continue
            out[k] = short(v, MAX_DESCRIPTION) if k == "description" and isinstance(v, str) else slim(v)
        return out
    if isinstance(node, list):
        return [slim(v) for v in node]
    return node


def refs(node, found):
    if isinstance(node, dict):
        r = node.get("$ref")
        if isinstance(r, str) and r.startswith("#/components/schemas/"):
            found.add(r.rsplit("/", 1)[1])
        for v in node.values():
            refs(v, found)
    elif isinstance(node, list):
        for v in node:
            refs(v, found)


def main(path):
    spec = yaml.safe_load(open(path, encoding="utf-8"))
    schemas = spec["components"]["schemas"]
    ops, used = [], set()
    for p, item in spec["paths"].items():
        for m in METHODS:
            op = item.get(m)
            if not isinstance(op, dict):
                continue
            content = (op.get("requestBody") or {}).get("content") or {}
            media = next(iter(content.values()), {}) if content else {}
            schema = media.get("schema") or {}
            ref = schema.get("$ref", "")
            name = ref.rsplit("/", 1)[1] if ref.startswith("#/components/schemas/") else None
            version = re.match(r"^[A-Z]+_(v\d)_", name or "")
            examples = media.get("examples") or {}
            example = None
            if examples:
                first = next(iter(examples.values()))
                value = first.get("value") if isinstance(first, dict) else None
                if value is not None:
                    text = json.dumps(value, ensure_ascii=False)
                    example = value if len(text) <= MAX_EXAMPLE else text[:MAX_EXAMPLE] + "…"
            entry = {
                "m": m.upper(),
                "p": p,
                "v": version.group(1) if version else "v1",
                "tag": (op.get("tags") or [""])[0],
                "s": short(op.get("summary") or op.get("description"), MAX_SUMMARY),
            }
            description = op.get("description") or ""
            if len(re.sub(r"\s+", " ", description)) > MAX_SUMMARY:
                entry["d"] = short(description, 3000)
            if name:
                entry["schema"] = name
                used.add(name)
            elif schema:
                entry["inline"] = slim(schema)
                refs(schema, used)
            if example is not None:
                entry["ex"] = example
            params = [
                {"name": x.get("name"), "in": x.get("in"), "required": bool(x.get("required"))}
                for x in op.get("parameters") or []
                if isinstance(x, dict) and "name" in x
            ]
            if params:
                entry["params"] = params
            ops.append(entry)

    # Fermeture transitive des schémas référencés.
    todo, kept = list(used), {}
    while todo:
        n = todo.pop()
        if n in kept or n not in schemas:
            continue
        kept[n] = slim(schemas[n])
        found = set()
        refs(schemas[n], found)
        todo.extend(found - kept.keys())

    out = {"title": spec["info"].get("title"), "operations": ops, "schemas": kept}
    with open("server/data/onestock-api.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(ops)} operations, {len(kept)} schemas")


if __name__ == "__main__":
    main(sys.argv[1])
