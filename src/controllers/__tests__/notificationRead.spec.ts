import { describe, it, expect } from "vitest";

/**
 * Read state belongs to the reader, not to the message.
 *
 * A notification addressed to a role is ONE document shared by everyone in that
 * role. With a single `isRead` flag on it, the first manager to open their bell
 * marked it read for every other manager — who then never saw it at all. The
 * same held for supervisors, cashiers and attendants: whoever looked first
 * silently cleared it for their colleagues.
 *
 * Mirrors isReadFor() in notification.controller.
 */
const isReadFor = (doc: any, staffId: string): boolean => {
  if (doc?.staff) return !!doc.isRead;
  const readers = (doc?.readBy ?? []).map((r: any) => String(r));
  return readers.includes(String(staffId)) || !!doc?.isRead;
};

describe("a station-wide notification is read per person", () => {
  const broadcast = { staff: null, isRead: false, readBy: ["manager-1"] };

  it("is read for the manager who opened it", () => {
    expect(isReadFor(broadcast, "manager-1")).toBe(true);
  });

  it("is STILL UNREAD for every other manager", () => {
    // The whole point. If this ever returns true, one person reading has again
    // hidden the message from their colleagues.
    expect(isReadFor(broadcast, "manager-2")).toBe(false);
    expect(isReadFor(broadcast, "supervisor-9")).toBe(false);
  });

  it("compares by value, so an ObjectId and its string form are one person", () => {
    const doc = { staff: null, isRead: false, readBy: [{ toString: () => "manager-1" }] };
    expect(isReadFor(doc, "manager-1")).toBe(true);
  });

  it("treats a never-read broadcast as unread for everyone", () => {
    expect(isReadFor({ staff: null, isRead: false, readBy: [] }, "manager-1")).toBe(false);
  });
});

describe("a personal notification keeps its single flag", () => {
  it("is read when its one recipient has read it", () => {
    expect(isReadFor({ staff: "attendant-3", isRead: true }, "attendant-3")).toBe(true);
  });

  it("is unread until then", () => {
    expect(isReadFor({ staff: "attendant-3", isRead: false }, "attendant-3")).toBe(false);
  });

  it("ignores readBy — a personal message has one reader by definition", () => {
    const doc = { staff: "attendant-3", isRead: false, readBy: ["manager-1"] };
    expect(isReadFor(doc, "attendant-3")).toBe(false);
  });
});

describe("notifications written before readBy existed", () => {
  it("stay read, rather than resurfacing as a pile of unread old news", () => {
    // Legacy broadcasts carry isRead: true and no readBy. Someone did read them;
    // showing them to everyone again would bury what is actually new. They
    // expire within days, so this fallback retires itself.
    const legacy = { staff: null, isRead: true, readBy: [] };
    expect(isReadFor(legacy, "manager-2")).toBe(true);
  });
});
