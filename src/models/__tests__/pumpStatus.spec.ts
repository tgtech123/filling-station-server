import { describe, it, expect } from "vitest";
import { effectivePumpStatus } from "../pump.model";

const AUG_3 = new Date("2026-08-03T00:00:00");
const AUG_4 = new Date("2026-08-04T00:00:00");

describe("effectivePumpStatus", () => {
  it("leaves a pump with no booking alone", () => {
    expect(effectivePumpStatus({ status: "Active" })).toBe("Active");
    expect(effectivePumpStatus({ status: "Inactive" })).toBe("Inactive");
  });

  it("keeps the pump working before the window opens", () => {
    // The reported bug: booking work for the 3rd flipped the pump to
    // Maintenance the instant it was scheduled, taking it out of service days
    // early — and nothing ever moved it back.
    const status = effectivePumpStatus(
      { status: "Active", maintenanceFrom: AUG_3, maintenanceTo: AUG_4 },
      new Date("2026-07-30T09:00:00")
    );
    expect(status).toBe("Scheduled");
  });

  it("takes the pump out of service on the first day", () => {
    expect(
      effectivePumpStatus(
        { status: "Active", maintenanceFrom: AUG_3, maintenanceTo: AUG_4 },
        new Date("2026-08-03T08:00:00")
      )
    ).toBe("Maintenance");
  });

  it("covers the whole of the final day — the end date is inclusive", () => {
    expect(
      effectivePumpStatus(
        { status: "Active", maintenanceFrom: AUG_3, maintenanceTo: AUG_4 },
        new Date("2026-08-04T23:30:00")
      )
    ).toBe("Maintenance");
  });

  it("returns the pump to service by itself once the window passes", () => {
    // Derived from the dates rather than a stored flag, so no scheduled job is
    // needed and the status cannot get stuck.
    expect(
      effectivePumpStatus(
        { status: "Active", maintenanceFrom: AUG_3, maintenanceTo: AUG_4 },
        new Date("2026-08-05T00:01:00")
      )
    ).toBe("Active");
  });

  it("is unaffected by a half-configured window", () => {
    expect(
      effectivePumpStatus({ status: "Active", maintenanceFrom: AUG_3, maintenanceTo: null })
    ).toBe("Active");
    expect(
      effectivePumpStatus({ status: "Active", maintenanceFrom: null, maintenanceTo: AUG_4 })
    ).toBe("Active");
  });

  it("falls back to Inactive when a pump has no status at all", () => {
    expect(effectivePumpStatus({})).toBe("Inactive");
  });
});
