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

// ---- catalog-based localisation (the Go `easybus-sdk/i18n` core) -----------
//
// Tool DESCRIPTIONS are localized through the manifest (description +
// descriptions[locale]). This covers the OTHER half: the runtime `content` and
// error text a tool returns, which is fed verbatim to the model.
//
//   - A Catalog is `{ key: { locale: template } }`; the locale set is an OPEN
//     map (any BCP-47-ish tag), so adding a language is pure data.
//   - Templates interpolate `{name}` placeholders.
//   - Resolution is total: requested locale -> its base language -> the
//     fallback locale (default `en`) -> its base -> any available -> the key.
//     A message is never empty, even for an untranslated locale.

/** BASE_LOCALE is the locale every catalog MUST provide (fallback termination). */
export const BASE_LOCALE = 'en'

export type Params = Record<string, string | number>
export type Catalog = Record<string, Record<string, string>>

/** baseLang lowercases and strips the region/script subtag: `zh-CN`, `zh_Hans`
 *  and `ZH` all collapse to `zh`. */
export function baseLang(locale: string): string {
  let l = locale.trim().toLowerCase().replace(/_/g, '-')
  const i = l.indexOf('-')
  if (i >= 0) l = l.slice(0, i)
  return l
}

const IDENT_RE = /^[a-zA-Z0-9_]+$/

/** interpolate replaces `{name}` placeholders; an unknown name is left literal. */
export function interpolate(template: string, params?: Params): string {
  if (!params || Object.keys(params).length === 0) return template
  return template.replace(/\{([^}]*)\}/g, (whole, name: string) => {
    if (!IDENT_RE.test(name)) return whole
    return name in params ? String(params[name]) : whole
  })
}

/** translate resolves one message. `locale` may be a full tag; matching walks
 *  exact -> base(locale) -> fallback -> base(fallback) -> first-available ->
 *  the key itself. */
export function translate(c: Catalog, key: string, locale: string, params?: Params, fallback = ''): string {
  const entry = c[key]
  if (!entry) return key
  const fb = fallback || BASE_LOCALE
  for (const cand of [locale, baseLang(locale), fb, baseLang(fb)]) {
    const tpl = entry[cand]
    if (tpl !== undefined) return interpolate(tpl, params)
  }
  for (const cand of [BASE_LOCALE, 'zh']) {
    const tpl = entry[cand]
    if (tpl !== undefined) return interpolate(tpl, params)
  }
  const any = Object.values(entry)[0]
  return any !== undefined ? interpolate(any, params) : key
}

/** defineI18n binds a catalog to a fallback locale (default `en`). */
export function defineI18n(catalog: Catalog, fallback = ''): { t: (locale: string, key: string, params?: Params) => string; catalog: Catalog } {
  const fb = fallback || BASE_LOCALE
  return {
    catalog,
    t: (locale, key, params) => translate(catalog, key, locale, params, fb),
  }
}
