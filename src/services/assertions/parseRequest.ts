import type { NostrEvent } from '../../store/types'

/**
 * Wire contract consumed from a kind-37572 request by the internal
 * Assertions service.
 *
 * `a` and `p` are validated upstream (KeyResolver + RequestPipeline) and
 * therefore intentionally NOT re-read here.
 */

// Set membership drives every output-kind decision below; adding future
// NIP-85 kinds (30383/30384/30385) is a one-line change here.
export const SUPPORTED_OUTPUT_KINDS = new Set<number>([37575, 30382])

// NIP-85 assertion kinds. Per tsm/nip85-bridge these carry no in-band
// vantage point (`d` is the subject), so they MUST be signed by a
// per-subscription pubkey, never by the shared service key.
export const NIP85_OUTPUT_KINDS = new Set<number>([30382, 30383, 30384, 30385])

// v1 only supports pubkey subjects; other NIP-85 subject-kinds require a
// different output tag layout and will be re-enabled with 30383+.
export const SUPPORTED_CONFIG_TYPES = new Set<string>(['p'])

export const DEFAULT_THRESHOLD = 0
export const DEFAULT_MAX_ITEMS = 1000
export const MAX_ITEMS_HARD_CAP = 1000

export interface ParsedAssertionsRequest {
  outputKinds: number[]
  povNaddr: string
  configType: string
  threshold: number
  maxItems: number
}

export type ParseResult =
  | { ok: true; request: ParsedAssertionsRequest }
  | { ok: false; code: string; detail?: string }

/**
 * Typed error thrown by the AssertionsClient when a request violates the
 * §2.1 contract. RequestPipeline recognizes this shape and surfaces the
 * `code` / `detail` as dedicated tags on the kind-7000 error feedback so
 * dashboards can react programmatically without parsing the human message.
 */
export class AssertionsRequestError extends Error {
  readonly code: string
  readonly detail?: string

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'AssertionsRequestError'
    this.code = code
    this.detail = detail
  }
}

function getConfigValue(event: NostrEvent, key: string): string | undefined {
  return event.tags.find(t => t[0] === 'config' && t[1] === key)?.[2]
}

export function parseAssertionsRequest(event: NostrEvent): ParseResult {
  // ── output kinds ────────────────────────────────────────────────────
  const rawKindTags = event.tags.filter(t => t[0] === 'k' && t[1] !== undefined)
  if (rawKindTags.length === 0) {
    return {
      ok: false,
      code: 'no_output_kinds',
      detail: 'request has no ["k", …] tags',
    }
  }

  const outputKinds: number[] = []
  const seenKinds = new Set<number>()
  for (const tag of rawKindTags) {
    const parsed = Number(tag[1])
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      return {
        ok: false,
        code: 'unsupported_output_kind',
        detail: String(tag[1]),
      }
    }
    if (!SUPPORTED_OUTPUT_KINDS.has(parsed)) {
      return {
        ok: false,
        code: 'unsupported_output_kind',
        detail: String(parsed),
      }
    }
    if (!seenKinds.has(parsed)) {
      seenKinds.add(parsed)
      outputKinds.push(parsed)
    }
  }

  // ── config:pov ──────────────────────────────────────────────────────
  const povNaddr = getConfigValue(event, 'pov')?.trim()
  if (!povNaddr) {
    return { ok: false, code: 'missing_pov' }
  }

  // ── config:type ─────────────────────────────────────────────────────
  const configType = getConfigValue(event, 'type')
  if (!configType || !SUPPORTED_CONFIG_TYPES.has(configType)) {
    return {
      ok: false,
      code: 'unsupported_config_type',
      detail: configType ?? '(none)',
    }
  }

  // ── config:threshold (optional) ─────────────────────────────────────
  const rawThreshold = getConfigValue(event, 'threshold')
  let threshold = DEFAULT_THRESHOLD
  if (rawThreshold !== undefined) {
    const parsed = Number(rawThreshold)
    if (!Number.isFinite(parsed)) {
      return { ok: false, code: 'invalid_threshold', detail: rawThreshold }
    }
    threshold = parsed
  }

  // ── config:max_items (optional, clamped) ────────────────────────────
  const rawMaxItems = getConfigValue(event, 'max_items')
  let maxItems = DEFAULT_MAX_ITEMS
  if (rawMaxItems !== undefined) {
    const parsed = Number(rawMaxItems)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, code: 'invalid_max_items', detail: rawMaxItems }
    }
    maxItems = Math.min(parsed, MAX_ITEMS_HARD_CAP)
  }

  return {
    ok: true,
    request: {
      outputKinds,
      povNaddr,
      configType,
      threshold,
      maxItems,
    },
  }
}
