import type { NostrEvent } from '../../store/types'
import { AssertionsRequestError } from './parseRequest'

export type SubjectTagLetter = 'p' | 'e' | 'a'

export interface PovSubject {
  tagLetter: SubjectTagLetter
  value: string
  rank: number
  raw: string[]
}

export interface ValidatedPov {
  dTag: string
  subjects: PovSubject[]
}

const SUBJECT_TAG_LETTERS = new Set<SubjectTagLetter>(['p', 'e', 'a'])
const OUTPUT_EVENT_KIND = 37573

function parseRank(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const parsed = parseFloat(raw)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

/**
 * Validate a fetched kind-37573 POV event and extract its subject tags.
 *
 * Mirrors the dashboard's `validateOutputEvent` positional layout:
 *   [tag_letter, subject, rank, pov_rank?, ranking_metadata_json?]
 *
 * - `tag_letter` is one of `p`, `e`, or `a`.
 * - `subject` is the entity identifier.
 * - `rank` is a numeric string; tags with non-numeric ranks are skipped.
 *
 * Throws {@link AssertionsRequestError} with code `invalid_pov_output` when
 * the event is the wrong kind, lacks a `d` tag, or has no usable result tags.
 */
export function validatePovEvent(event: NostrEvent): ValidatedPov {
  if (event.kind !== OUTPUT_EVENT_KIND) {
    throw new AssertionsRequestError(
      'invalid_pov_output',
      `POV event kind ${event.kind}; expected ${OUTPUT_EVENT_KIND}`,
      String(event.kind),
    )
  }

  const dTag = event.tags.find(t => t[0] === 'd')?.[1]
  if (!dTag) {
    throw new AssertionsRequestError(
      'invalid_pov_output',
      'POV event missing `d` tag',
    )
  }

  const subjects: PovSubject[] = []
  for (const tag of event.tags) {
    const letter = tag[0]
    if (!SUBJECT_TAG_LETTERS.has(letter as SubjectTagLetter)) continue

    const value = tag[1]
    if (!value) continue

    const rank = parseRank(tag[2])
    if (rank === null) continue

    subjects.push({
      tagLetter: letter as SubjectTagLetter,
      value,
      rank,
      raw: tag,
    })
  }

  if (subjects.length === 0) {
    throw new AssertionsRequestError(
      'invalid_pov_output',
      'POV event has no well-formed result tags',
    )
  }

  return { dTag, subjects }
}
