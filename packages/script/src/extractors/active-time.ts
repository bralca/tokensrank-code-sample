/**
 * Active-time accounting for a session's event timeline.
 *
 * A session's first→last span overstates real work because a session_id can be
 * reused across days with long idle gaps. We instead measure *active* time:
 * walk the event timestamps and split into stretches wherever the gap between
 * consecutive events exceeds IDLE_GAP_MS. Total active = sum of stretch lengths;
 * longest = the single longest uninterrupted stretch ("longest session").
 */

/** A gap larger than this ends the current uninterrupted stretch (30 minutes). */
export const IDLE_GAP_MS = 30 * 60 * 1000;

export type ActiveTime = { activeSeconds: number; longestActiveSeconds: number };

/**
 * Streaming-friendly O(1)-memory accumulator: feed event epoch-ms in arrival
 * order (logs are chronological), then read the result. Used by the Claude
 * extractor, which processes turns one at a time without holding them all.
 */
export class ActiveTimeAccumulator {
  private prevMs = NaN;
  private stretchStartMs = NaN;
  private totalMs = 0;
  private longestMs = 0;

  add(eventMs: number): void {
    if (!Number.isFinite(eventMs)) return;
    if (Number.isNaN(this.prevMs)) {
      this.prevMs = eventMs;
      this.stretchStartMs = eventMs;
      return;
    }
    const gap = eventMs - this.prevMs;
    if (gap > IDLE_GAP_MS) {
      this.closeStretch();
      this.stretchStartMs = eventMs;
    }
    // Clamp backwards (out-of-order) events to avoid negative stretch math.
    this.prevMs = Math.max(this.prevMs, eventMs);
  }

  private closeStretch(): void {
    const dur = this.prevMs - this.stretchStartMs;
    if (dur > 0) {
      this.totalMs += dur;
      if (dur > this.longestMs) this.longestMs = dur;
    }
  }

  result(): ActiveTime {
    if (Number.isNaN(this.prevMs)) return { activeSeconds: 0, longestActiveSeconds: 0 };
    this.closeStretch();
    return {
      activeSeconds: Math.round(this.totalMs / 1000),
      longestActiveSeconds: Math.round(this.longestMs / 1000),
    };
  }
}

/** Compute active time from a full list of event epoch-ms (sorts defensively). */
export function activeTimeFromTimestamps(timestampsMs: number[]): ActiveTime {
  const acc = new ActiveTimeAccumulator();
  for (const ms of [...timestampsMs].sort((a, b) => a - b)) acc.add(ms);
  return acc.result();
}
