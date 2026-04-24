import crypto from "crypto";

/** Wait for a given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Trim whitespace and collapse internal runs of whitespace to a single space. */
export function cleanText(value: string | undefined | null): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Parse a numeric string into a positive integer.
 * Strips commas, whitespace, and common area suffixes (SF, sqft, etc.).
 * Returns null if the result is not a finite positive number.
 */
export function parseNumber(value: string | undefined | null): number | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[,\s]/g, "")
    .replace(/sf|sqft|sq\.?\s*ft\.?/gi, "")
    .trim();
  const num = parseInt(cleaned, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Parse a year string. Returns null if the value isn't a plausible 4-digit year.
 */
export function parseYear(value: string | undefined | null): number | null {
  const num = parseNumber(value);
  if (num === null) return null;
  return num >= 1800 && num <= 2100 ? num : null;
}

/**
 * Derive a stable, deterministic 16-char hex key from address + zip.
 * Used to deduplicate properties across runs.
 */
export function makePropertyKey(address: string, zip: string): string {
  const raw = `${address.trim().toLowerCase()}|${zip.trim()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
