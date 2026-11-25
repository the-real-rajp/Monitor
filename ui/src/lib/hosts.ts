// Address checks for the device forms. They mirror WebPinger::validHost on the
// server, which has the final say; these exist to catch typos before saving.

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === "0" || !p.startsWith("0")))
  );
}

/** Why `host` cannot be monitored, in words for the person typing it, or null if it can. */
export function hostProblem(host: string): string | null {
  const h = host.trim();
  if (h === "") return "Enter a hostname or IP address.";
  if (/\s/.test(h)) return "An address cannot contain spaces.";
  if (/^[\d.]+$/.test(h)) {
    return isIPv4(h) ? null : "That looks like an IP address, but it is not a valid one.";
  }
  if (h.includes(":")) {
    return /^[0-9a-f:.]+$/i.test(h) && h.split(":").length > 2
      ? null
      : "That is not a valid IPv6 address. Leave out any port or brackets.";
  }
  if (h.includes("/")) return "Enter just the hostname, without http:// or a path.";
  return HOSTNAME.test(h) ? null : "That is not a valid hostname or IP address.";
}

export interface BulkLine {
  /** 1-based line number in the pasted text. */
  line: number;
  text: string;
  name: string;
  host: string;
  /** Set when this line will not be added as it stands. */
  problem: string | null;
}

/**
 * Parse pasted lines of "Name, address" (comma or tab between them). A line
 * with only an address uses it as the name too. An IP address in the first
 * position is accepted, since that is how spreadsheets are often laid out.
 * `taken` maps addresses already monitored (lower case) to the device's name.
 */
export function parseBulk(text: string, taken: Map<string, string>): BulkLine[] {
  const seen = new Map<string, number>();
  const out: BulkLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (t === "") return;
    const cut = t.search(/[\t,]/);
    let name = cut === -1 ? "" : t.slice(0, cut).trim();
    let host = cut === -1 ? t : t.slice(cut + 1).trim();
    // Only an IP address in the name position means the columns are swapped; a
    // plain word there is a name, even though it would also pass as a hostname.
    const nameIsIp = /^[\d.]+$/.test(name) || name.includes(":");
    if (nameIsIp && hostProblem(name) === null && hostProblem(host) !== null) {
      [name, host] = [host, name];
    }
    if (name === "") name = host;
    const key = host.toLowerCase();
    let problem = hostProblem(host);
    if (problem === null && name.length > 100) problem = "The name is longer than 100 characters.";
    if (problem === null && taken.has(key)) {
      problem = `${host} is already monitored as “${taken.get(key)}”.`;
    }
    if (problem === null && seen.has(key)) {
      problem = `${host} is also on line ${seen.get(key)}.`;
    }
    if (problem === null) seen.set(key, i + 1);
    out.push({ line: i + 1, text: raw, name, host, problem });
  });
  return out;
}
