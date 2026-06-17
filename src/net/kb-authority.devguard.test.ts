/*
 * Guards the KnockBox SDK's per-recipient dev check (see addons/knockbox/kb-authority.js): under the
 * local-testing transport, KBAuthority deep-freezes the `currentView` it hands a guest so an
 * accidental mutation of that render copy throws instead of silently diverging in production. This is
 * the small linkable reference the platform guide (§5a / §11) points to. Alpha Chain itself hand-rolls
 * its controller and doesn't use KBAuthority — this test exercises the shared SDK directly.
 */

import { afterEach, describe, expect, it } from "vitest";
import KBAuthorityImport from "../../addons/knockbox/kb-authority.js";
import KnockBoxLocalImport from "../../addons/knockbox/knockbox-local.js";

// The UMD addon exports are typed `unknown` (knockbox-addons.d.ts); give them just enough structure
// to drive here.
interface LocalPeer {
  isLocal: boolean;
  start(): void;
  destroy(): void;
}
type LocalPeerCtor = new (opts: { mode: "process"; channel: string; playerId: string }) => LocalPeer;

interface Authority {
  currentView: Record<string, unknown> | null;
  sendIntent(action: unknown): void;
  destroy(): void;
}
type AuthorityCtor = new (
  net: LocalPeer,
  model: unknown,
  options?: { perRecipient?: boolean; devChecks?: boolean },
) => Authority;

const KBAuthority = KBAuthorityImport as unknown as AuthorityCtor;
const local = KnockBoxLocalImport as unknown as {
  KnockBoxLocalPeer: LocalPeerCtor;
  _resetLocalHubs: () => void;
};

/** A macrotask tick drains the SDK's queued microtask deliveries (start → register → sync → state). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A per-recipient host model: it projects a per-player view; guests need no model.
const makeHostModel = () => ({
  n: 0,
  applyIntent(_from: string, action: { kind?: string }): boolean | null {
    if (action && action.kind === "bump") {
      this.n += 1;
      return true; // per-recipient: truthy accepts; the host re-projects to everyone
    }
    return null;
  },
  snapshot(pid?: string) {
    return { you: pid, n: this.n, nested: { tags: ["a", "b"] } };
  },
});

describe("KBAuthority per-recipient dev guard", () => {
  afterEach(() => local._resetLocalHubs());

  const startPair = (channel: string, opts: { perRecipient?: boolean; devChecks?: boolean }) => {
    const host = new local.KnockBoxLocalPeer({ mode: "process", channel, playerId: "h" });
    const guest = new local.KnockBoxLocalPeer({ mode: "process", channel, playerId: "g" });
    const hostAuth = new KBAuthority(host, makeHostModel(), opts);
    const guestAuth = new KBAuthority(guest, {}, opts);
    host.start();
    guest.start();
    return { host, guest, hostAuth, guestAuth };
  };

  it("freezes the guest's currentView so a stray mutation throws (dev default under local peer)", async () => {
    const { guest, guestAuth } = startPair("guard-on", { perRecipient: true });
    expect(guest.isLocal).toBe(true); // devChecks auto-enables under the local transport
    await settle();
    await settle();

    const cv = guestAuth.currentView;
    expect(cv).not.toBeNull();
    expect(cv?.you).toBe("g"); // the host projected this guest's own view
    expect(Object.isFrozen(cv)).toBe(true);
    expect(Object.isFrozen((cv as { nested: object }).nested)).toBe(true); // deep
    expect(() => {
      (cv as { n: number }).n = 999;
    }).toThrow();
  });

  it("keeps updating currentView on new snapshots even with the guard on", async () => {
    const { guestAuth } = startPair("guard-converge", { perRecipient: true });
    await settle();
    await settle();
    expect(guestAuth.currentView?.n).toBe(0);

    guestAuth.sendIntent({ kind: "bump" }); // host applies + re-projects
    await settle();
    await settle();
    expect(guestAuth.currentView?.n).toBe(1); // replaced wholesale, converged
    expect(Object.isFrozen(guestAuth.currentView)).toBe(true); // and still frozen
  });

  it("leaves currentView writable when devChecks is explicitly off", async () => {
    const { guestAuth } = startPair("guard-off", { perRecipient: true, devChecks: false });
    await settle();
    await settle();

    const cv = guestAuth.currentView;
    expect(cv).not.toBeNull();
    expect(Object.isFrozen(cv)).toBe(false);
    expect(() => {
      (cv as { n: number }).n = 5; // no freeze → no throw
    }).not.toThrow();
  });
});
