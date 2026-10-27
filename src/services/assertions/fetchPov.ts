import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { decode, type AddressPointer, type NAddr } from 'nostr-tools/nip19'
import WebSocket from 'ws'
import type { NostrEvent } from '../../store/types'
import { AssertionsRequestError } from './parseRequest'

const POV_FETCH_TIMEOUT_MS = 15_000
const POV_EVENT_KIND = 37573

// nostr-tools' SimplePool expects a global WebSocket, which Node <21 does
// not provide. Register the `ws` implementation once at module load so
// one-shot POV fetches work on the orchestrator's Node 18 target.
useWebSocketImplementation(WebSocket)

/**
 * Resolve a `config:pov` naddr to its kind-37573 output event.
 *
 * The filter pins `authors`, `kinds`, and `#d` from the decoded address
 * pointer so a hostile relay cannot substitute an event with the same `d`
 * tag from a different author. Relay set is the naddr's own hints unioned
 * with the service's default read relays.
 *
 * Throws {@link AssertionsRequestError} on any failure so the pipeline can
 * surface a structured kind-7000 error.
 */
export async function fetchPovEvent(
  naddr: string,
  defaultReadRelays: string[],
): Promise<NostrEvent> {
  let pointer: AddressPointer
  try {
    const decoded = decode(naddr as NAddr)
    if (decoded.type !== 'naddr') {
      throw new Error(`expected naddr, got ${decoded.type}`)
    }
    pointer = decoded.data
  } catch (err) {
    throw new AssertionsRequestError(
      'invalid_pov_naddr',
      `config:pov is not a decodable naddr: ${err instanceof Error ? err.message : String(err)}`,
      naddr.slice(0, 24),
    )
  }

  if (pointer.kind !== POV_EVENT_KIND) {
    throw new AssertionsRequestError(
      'pov_kind_mismatch',
      `config:pov points to kind ${pointer.kind}; expected ${POV_EVENT_KIND}`,
      String(pointer.kind),
    )
  }

  const relays = [
    ...new Set([...(pointer.relays ?? []), ...defaultReadRelays]),
  ].filter(Boolean)
  if (relays.length === 0) {
    throw new AssertionsRequestError(
      'pov_no_relays',
      'no relays available to fetch config:pov (naddr had no hints and no default read relays)',
    )
  }

  const pool = new SimplePool()
  try {
    const event = await pool.get(
      relays,
      {
        kinds: [pointer.kind],
        authors: [pointer.pubkey],
        '#d': [pointer.identifier],
      },
      { maxWait: POV_FETCH_TIMEOUT_MS },
    )

    if (!event) {
      throw new AssertionsRequestError(
        'pov_not_found',
        `kind-${POV_EVENT_KIND} POV not found on ${relays.length} relay(s)`,
        pointer.identifier,
      )
    }

    return event as unknown as NostrEvent
  } finally {
    pool.close(relays)
  }
}
