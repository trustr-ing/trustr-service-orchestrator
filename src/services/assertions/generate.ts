import type { UnsignedEvent } from '../../store/types'
import type { PovSubject } from './validatePov'

/**
 * Canonical bridge `rank` Output Standard (kind 37571), maintained
 * alongside tsm/nip85-bridge. Referenced (not re-published) by every
 * assertion event this service emits so consumers can resolve the meaning
 * and value type (0-100 int) of the `rank` assertion tag.
 *
 * This 37571 event is the "assertion source" — distinct from the request's
 * `config:pov` (kind 37573), which is the "subject + source-rank" provider.
 */
export const RANK_STANDARD_PUBKEY =
  'df67f9a7e41125745cbe7acfbdcd03691780c643df7bad70f5d2108f2d4fc200'
export const RANK_STANDARD_RELAY = 'wss://relay.primal.net'
export const RANK_STANDARD_COORDINATE = `37571:${RANK_STANDARD_PUBKEY}:rank`
export const RANK_ASSERTION_LABEL = 'rank'

const TSM_SUBJECT_ASSERTIONS_KIND = 37575

// NIP-85 subject-kind per TSM `config:type` tag letter. v1 only exercises
// `p` → 30382; the rest are pre-wired so future subject types are a
// one-line parser change (see SUPPORTED_CONFIG_TYPES).
const NIP85_KIND_BY_TYPE: Record<string, number> = {
  p: 30382,
  e: 30383,
  a: 30384,
  i: 30385,
}

export interface BuildSubjectAssertionsOptions {
  outputKinds: number[]
  configType: string
  threshold: number
  maxItems: number
  povNaddr: string
  requestId: string
  requestAuthorPubkey: string
  requestDTag: string
  createdAt?: number
}

/**
 * Coerce an input rank onto the `37571` `rank` standard's 0-100 integer
 * scale. GrapeRank-style 0..1 values are scaled up; values already on a
 * 0-100 scale pass through. Result is rounded and clamped to [0, 100].
 */
export function coerceRankTo0to100(raw: number): number {
  const scaled = raw <= 1 ? raw * 100 : raw
  return Math.max(0, Math.min(100, Math.round(scaled)))
}

function rankProvenanceTags(
  requestId: string,
  requestAuthorPubkey: string,
  povNaddr: string,
  configType: string,
): string[][] {
  return [
    ['v', `pov:${povNaddr}`],
    ['v', `type:${configType}`],
    ['v', `a:${RANK_STANDARD_COORDINATE}`, RANK_STANDARD_RELAY, RANK_ASSERTION_LABEL],
    ['v', `assertion:${RANK_ASSERTION_LABEL}`],
    ['v', `p:${requestAuthorPubkey}`],
    ['v', `d:${requestId}`],
  ]
}

function buildSubjectAssertionsEvent(
  subject: PovSubject,
  normalizedRank: number,
  options: BuildSubjectAssertionsOptions,
  createdAt: number,
): UnsignedEvent {
  const { configType, povNaddr, requestId, requestAuthorPubkey, requestDTag } = options
  return {
    kind: TSM_SUBJECT_ASSERTIONS_KIND,
    created_at: createdAt,
    content: '',
    tags: [
      // Namespaced by request author so that two users exporting with the
      // same user-chosen `d` under a shared service key never replace each
      // other's assertions. Under a per-subscription key the prefix is
      // redundant but harmless and keeps the identifier shape uniform.
      ['d', `${requestAuthorPubkey}:${requestDTag}:${configType}:${subject.value}`],
      ['v', `pov:${povNaddr}`],
      ['v', `type:${configType}`],
      ['v', `a:${RANK_STANDARD_COORDINATE}`, RANK_STANDARD_RELAY, RANK_ASSERTION_LABEL],
      ['v', `assertion:${RANK_ASSERTION_LABEL}`],
      ['v', `p:${requestAuthorPubkey}`],
      ['v', `d:${requestId}`],
      [configType, subject.value, String(normalizedRank)],
      [RANK_ASSERTION_LABEL, String(normalizedRank)],
    ],
  }
}

function buildNip85AssertionEvent(
  nip85Kind: number,
  subject: PovSubject,
  normalizedRank: number,
  options: BuildSubjectAssertionsOptions,
  createdAt: number,
): UnsignedEvent {
  const { povNaddr, requestId, requestAuthorPubkey, configType } = options
  return {
    kind: nip85Kind,
    created_at: createdAt,
    content: '',
    tags: [
      ['d', subject.value],
      [RANK_ASSERTION_LABEL, String(normalizedRank)],
      ...rankProvenanceTags(requestId, requestAuthorPubkey, povNaddr, configType),
    ],
  }
}

/**
 * Build the unsigned assertion events for a request's POV subjects.
 *
 * Subjects are filtered to the request's `config:type`, filtered by
 * `threshold` on the source rank scale, sorted by rank descending, and
 * capped at `maxItems`. For each surviving subject, one event per
 * requested output kind is produced. All rank values rendered in output
 * are normalized to the `37571` 0-100 integer standard.
 *
 * Pure and deterministic (pass `createdAt` for reproducible tests).
 */
export function buildSubjectAssertions(
  subjects: PovSubject[],
  options: BuildSubjectAssertionsOptions,
): UnsignedEvent[] {
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000)
  const nip85Kind = NIP85_KIND_BY_TYPE[options.configType]

  const selected = subjects
    .filter(subject => subject.tagLetter === options.configType)
    .filter(subject => subject.rank >= options.threshold)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, options.maxItems)

  const wantsSubjectAssertions = options.outputKinds.includes(TSM_SUBJECT_ASSERTIONS_KIND)
  const wantsNip85 = nip85Kind !== undefined && options.outputKinds.includes(nip85Kind)

  const events: UnsignedEvent[] = []
  for (const subject of selected) {
    const normalizedRank = coerceRankTo0to100(subject.rank)

    if (wantsSubjectAssertions) {
      events.push(buildSubjectAssertionsEvent(subject, normalizedRank, options, createdAt))
    }
    if (wantsNip85) {
      events.push(buildNip85AssertionEvent(nip85Kind, subject, normalizedRank, options, createdAt))
    }
  }

  return events
}
