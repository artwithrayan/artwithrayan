const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const config = { ...process.env };
if (fs.existsSync(path.join(root, ".env"))) Object.assign(config, dotenv.parse(fs.readFileSync(path.join(root, ".env"))));
const known = Object.entries(config)
  .filter(([name, value]) => /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(name) && value?.length >= 12)
  .flatMap(([name, value]) => [value, encodeURIComponent(value), value.replace(/\\n/g, "\n")].map((text) => ({ name, text })));
const signatures = [
  ["Stripe secret key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{24,}/],
  ["Resend key", /\bre_[A-Za-z0-9_]{24,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{60,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Google service account credential", /"type"\s*:\s*"service_account"[\s\S]*"private_key"\s*:/],
  ["Credential URL", /https?:\/\/[^\s/:]+:[^\s/@]{8,}@/]
];
const findings = [];
function scan(content, location) {
  const types = new Set();
  for (const { name, text } of known) if (content.includes(text)) types.add(`configured ${name}`);
  for (const [name, pattern] of signatures) if (pattern.test(content)) types.add(name);
  if (types.size) findings.push({ location, types: [...types] });
}
function sensitivePath(filename) {
  return /(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx|sqlite(?:-shm|-wal)?|db)|credentials[^/]*\.json|[^/]*service[-_]account[^/]*\.json)$/i.test(filename) && !/\.env\.(?:example|sample|template)$/.test(filename);
}
function textFile(filename) { return /\.(?:[cm]?js|json|html|css|md|txt|ya?ml|toml|sh|ps1|env|pem|key)$/i.test(filename) || /(?:^|\/)\.[^/]+$/.test(filename); }
const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
for (const filename of files) {
  if (sensitivePath(filename)) findings.push({ location: filename, types: ["sensitive file tracked or not ignored"] });
  const full = path.join(root, filename);
  if (textFile(filename) && fs.existsSync(full)) scan(fs.readFileSync(full, "utf8"), filename);
}
// Public files are deployable even when Git ignores them.
function scanPublic(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).replaceAll("\\", "/");
    if (entry.isDirectory()) scanPublic(full);
    else {
      if (sensitivePath(relative)) findings.push({ location: relative, types: ["sensitive file in public directory"] });
      if (textFile(relative)) scan(fs.readFileSync(full, "utf8"), relative);
    }
  }
}
scanPublic(path.join(root, "public"));
let historicalFiles = 0;
if (process.argv.includes("--history")) {
  const entries = git("rev-list", "--objects", "--all").trim().split("\n");
  for (const entry of entries) {
    const space = entry.indexOf(" ");
    if (space === -1) continue;
    const oid = entry.slice(0, space), filename = entry.slice(space + 1);
    if (sensitivePath(filename)) findings.push({ location: `${oid.slice(0, 12)}:${filename}`, types: ["sensitive file in Git history"] });
    if (!textFile(filename)) continue;
    if (git("cat-file", "-t", oid).trim() !== "blob") continue;
    scan(git("cat-file", "blob", oid), `${oid.slice(0, 12)}:${filename}`);
    historicalFiles++;
  }
}
// Never print matching lines or values: reports contain paths and credential types only.
console.log(JSON.stringify({ scannedWorkingFiles: files.length, historicalFiles, findings }, null, 2));
if (findings.length) process.exitCode = 1;
