// ---------------------------------------------------------------------------
// Prefix-based capability matcher
// Supports hierarchical labels: "tech_support.api" matches executor with
// ["tech_support"] but "finance" does not match ["tech_support"].
// ---------------------------------------------------------------------------

export interface DomainMatcher {
  /** Returns true if `executorAbilities` covers every label in `required`. */
  matches(required: string[], executorAbilities: string[]): boolean;
}

/** Prefix matcher: a required ability matches if any executor ability
 *  is an exact match or a prefix segment of the required ability.
 *
 *  Examples:
 *    matches(["tech_support.api"], ["tech_support"])          → true
 *    matches(["finance"], ["tech_support"])                   → false
 *    matches(["tech_support"], ["tech_support.api"])          → true
 *    matches(["general"], ["tech_support", "general"])        → true
 */
export class PrefixMatcher implements DomainMatcher {
  matches(required: string[], executorAbilities: string[]): boolean {
    if (required.length === 0) return true;
    if (executorAbilities.length === 0) return true;
    return required.every(req =>
      executorAbilities.some(ability =>
        req === ability ||
        req.startsWith(ability + '.') ||
        ability.startsWith(req + '.'),
      ),
    );
  }
}
