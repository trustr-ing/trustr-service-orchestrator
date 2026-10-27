import { npubEncode } from 'nostr-tools/nip19'
import type { ServiceRecord, UnsignedEvent } from '../../store/types'
import {
  RANK_STANDARD_COORDINATE,
  RANK_STANDARD_RELAY,
  RANK_ASSERTION_LABEL,
} from './generate'
import { DEFAULT_MAX_ITEMS, MAX_ITEMS_HARD_CAP } from './parseRequest'

const BRIDGE_NIP_URL = 'https://github.com/trustr-ing/tsm/blob/main/nip85-bridge.md'
const TRUSTR_WEBSITE = 'https://trustr.ing'

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Kind-37570 service announcement for the internal assertions service.
 * Shape follows the GrapeRank service announcement (title/summary/config
 * tags with [name, type, description, default, allowed]) plus the
 * bridge-essential content from tsm/nip85-bridge: `k` 30382 with a fixed
 * `config:type`, `config:pov`, and one `a` tag per supported assertion
 * referencing its kind-37571 Output Standard, labelled as rendered.
 */
export function buildAssertionsAnnouncement(): UnsignedEvent {
  return {
    kind: 37570,
    created_at: now(),
    content: '',
    tags: [
      ['n', BRIDGE_NIP_URL],
      ['k', '37575'],
      ['k', '30382'],
      ['title', 'Trustr Assertions'],
      [
        'summary',
        'Subject assertions derived from a TrustR ranked output: TSM Subject Assertions ' +
          '(kind 37575) and NIP-85 Trusted Assertions (kind 30382). Point config:pov at a ' +
          'kind-37573 output; each subject at or above the threshold receives a 0-100 rank ' +
          'assertion. Kind 30382 is issued only to requests addressed to a subscription pubkey, ' +
          'so those assertions are signed from the requesting user\'s own point of view.',
      ],
      ['config', 'type', 'tagletter', 'Subject type (fixed)', 'p', '["p"]'],
      ['config', 'pov', 'naddr', 'naddr of the kind-37573 ranked output to assert from'],
      [
        'config',
        'threshold',
        '0-1',
        'Minimum source rank (inclusive) for a subject to be asserted',
        '0',
        '[0,1]',
      ],
      [
        'config',
        'max_items',
        'integer',
        `Maximum subjects asserted per request (hard cap ${MAX_ITEMS_HARD_CAP})`,
        String(DEFAULT_MAX_ITEMS),
        `[1,${MAX_ITEMS_HARD_CAP}]`,
      ],
      ['a', RANK_STANDARD_COORDINATE, RANK_STANDARD_RELAY, RANK_ASSERTION_LABEL],
    ],
  }
}

/** Kind-0 profile for the assertions service key. */
export function buildServiceProfile(service: ServiceRecord): UnsignedEvent {
  return {
    kind: 0,
    created_at: now(),
    tags: [],
    content: JSON.stringify({
      name: service.name,
      about:
        'TrustR assertions service. Publishes TSM Subject Assertions (kind 37575) ' +
        'and, via per-user subscription keys, NIP-85 Trusted Assertions (kind 30382) ' +
        'computed from TrustR ranked outputs. See the kind-37570 announcement for the request contract.',
      website: TRUSTR_WEBSITE,
      bot: true,
    }),
  }
}

/**
 * Kind-0 profile for a per-user subscription key that signs 30382 events.
 * Names the key after the requesting user so NIP-85 consumers can read
 * "this provider = <user>'s point of view, computed by TrustR".
 */
export function buildSubscriptionProviderProfile(
  subscriptionPubkey: string,
  userPubkey: string,
): UnsignedEvent {
  const npub = npubEncode(userPubkey)
  return {
    kind: 0,
    created_at: now(),
    tags: [['p', userPubkey]],
    content: JSON.stringify({
      name: `TrustR · ${npub.slice(0, 12)}…`,
      about:
        `NIP-85 Trusted Assertions (kind 30382) computed by TrustR from the point of view of ` +
        `${npub}. Provider key ${subscriptionPubkey.slice(0, 8)}… is issued to that user by the ` +
        'TrustR assertions service; add it to your kind-10040 list for 30382:rank to use these ranks.',
      website: TRUSTR_WEBSITE,
      bot: true,
    }),
  }
}
