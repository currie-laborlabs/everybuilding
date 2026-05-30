import { describe, expect, it } from "vitest";
import { normalizeBatchDataPermits } from "../enrichment/batchdata-property";

describe("normalizeBatchDataPermits", () => {
  it("reads legacy top-level permits arrays", () => {
    const permits = normalizeBatchDataPermits({
      permits: [
        {
          permitType: "Roofing",
          issueDate: "2024-03-04",
          contractor: "ABC Roofing",
          description: "Replace roof membrane",
        },
      ],
    });

    expect(permits).toEqual([
      {
        permitType: "Roofing",
        issueDate: "2024-03-04",
        contractor: "ABC Roofing",
        description: "Replace roof membrane",
        status: "",
      },
    ]);
  });

  it("reads BatchData's singular permit object with nested records", () => {
    const permits = normalizeBatchDataPermits({
      permit: {
        records: [
          {
            permit_type: "HVAC",
            issued_date: "2023-09-12",
            contractor_name: "Mechanical Co",
            work_description: "Replace rooftop unit",
            permit_status: "Issued",
          },
        ],
      },
    });

    expect(permits).toEqual([
      {
        permitType: "HVAC",
        issueDate: "2023-09-12",
        contractor: "Mechanical Co",
        description: "Replace rooftop unit",
        status: "Issued",
      },
    ]);
  });

  it("returns an empty array for empty permit objects", () => {
    const permits = normalizeBatchDataPermits({ permit: {} });
    expect(permits).toEqual([]);
  });
});
