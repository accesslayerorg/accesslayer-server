let pushSentTotal = 0;
let pushTransientFailuresTotal = 0;
let pushExpiredRemovedTotal = 0;

export function incrementPushSent(): void {
   pushSentTotal += 1;
}

export function incrementPushTransientFailure(): void {
   pushTransientFailuresTotal += 1;
}

export function incrementPushExpiredRemoved(): void {
   pushExpiredRemovedTotal += 1;
}

export function getPushMetrics() {
   return {
      push_sent_total: pushSentTotal,
      push_transient_failures_total: pushTransientFailuresTotal,
      push_expired_removed_total: pushExpiredRemovedTotal,
   };
}

export function resetPushMetrics(): void {
   pushSentTotal = 0;
   pushTransientFailuresTotal = 0;
   pushExpiredRemovedTotal = 0;
}
