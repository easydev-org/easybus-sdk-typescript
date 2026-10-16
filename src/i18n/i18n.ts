// Localization — the TS twin of the Go `easybus-sdk/i18n` package. Resolves an
// extension-authored string for a locale: descriptions[locale] -> the primary
// fallback -> the base string.

export interface Localized {
  description?: string
  descriptions?: Record<string, string>
}

/** resolve returns the localized string for a locale ('' => the base). */
export function resolve(loc: Localized, locale: string): string {
  if (locale && loc.descriptions?.[locale]) return loc.descriptions[locale]!
  return loc.description ?? ''
}

/**
 * resolveSchema walks a JSON-Schema node and localizes every `description`
 * from its sibling `descriptions[locale]`, stripping the `descriptions` key
 * (the convention shared with the Go SDK) so the schema reaches a model clean.
 */
export function resolveSchema(node: unknown, locale: string): unknown {
  if (Array.isArray(node)) return node.map(n => resolveSchema(n, locale))
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'descriptions') continue
    if (k === 'description' && typeof v === 'string') {
      const descs = (node as Record<string, unknown>)['descriptions'] as Record<string, string> | undefined
      out['description'] = locale && descs?.[locale] ? descs[locale] : v
      continue
    }
    out[k] = resolveSchema(v, locale)
  }
  return out
}
