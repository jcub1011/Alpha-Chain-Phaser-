/*
 * Compile-time proof (not a runtime test) that the KnockBox SDK's opt-in view typing makes a stray
 * write to a replicated render copy a TYPE ERROR. Parameterizing KBAuthority<TView> types
 * `currentView` as DeepReadonly<TView>; the @ts-expect-error below fails the build if that ever stops
 * holding. tsc compiles this file (it lives under src/); vitest ignores it (not a *.test.ts).
 */

import type { KBAuthority } from "../../addons/knockbox/knockbox-phaser";

interface MyView {
  score: number;
  nested: { hits: number[] };
}

export function _assertReplicatedViewIsReadonly(auth: KBAuthority<MyView>): void {
  // Reading the replicated view is fine.
  const _score: number | undefined = auth.currentView?.score;
  void _score;

  // @ts-expect-error — currentView is a DeepReadonly render copy; mutating it must not compile.
  if (auth.currentView) auth.currentView.score = 1;

  // @ts-expect-error — deep: nested fields are read-only too.
  if (auth.currentView) auth.currentView.nested.hits.push(1);
}
