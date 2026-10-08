const { inspect } = require("node:util");

function redactSecrets(value) {
  let text = String(value ?? "");
  const secrets = new Set();
  for (const [name, raw] of Object.entries(process.env)) {
    if (!/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(name) || !raw || raw.length < 8) continue;
    const normalized = raw.replace(/\\n/g, "\n");
    for (const secret of [raw, normalized, ...normalized.split("\n").filter((line) => line.length >= 24)]) {
      secrets.add(secret);
      secrets.add(encodeURIComponent(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
    if (name === "PRINTFUL_API_KEY") secrets.add(Buffer.from(`${raw}:`).toString("base64"));
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:[rs]k_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|re_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED JWT]")
    .replace(/([?&](?:token|key|api_key|secret|access_token)=)[^\s&#'"<>]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function publicErrorMessage(error, fallback = "Could not complete this request. Please try again.") {
  const message = String(error?.message || "");
  if (!message || redactSecrets(message) !== message || /(?:api.?key|private.?key|authorization|authentication|credential|\[REDACTED)/i.test(message)) return fallback;
  if ([401, 403].includes(Number(error?.statusCode)) || Number(error?.statusCode) >= 500) return fallback;
  return message.slice(0, 400);
}

function safeLogValue(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactSecrets(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value) || depth > 4) return "[Omitted]";
  seen.add(value);
  // SDK errors can carry complete HTTP requests. Log diagnostics, never those requests.
  if (value instanceof Error) return safeLogValue({ name: value.name, message: value.message, code: value.code, statusCode: value.statusCode }, seen, depth + 1);
  if (Array.isArray(value)) return value.map((item) => safeLogValue(item, seen, depth + 1));
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => [
    key,
    /secret|token|password|private.?key|api.?key|authorization|cookie/i.test(key)
      ? "[REDACTED]"
      : "value" in descriptor ? safeLogValue(descriptor.value, seen, depth + 1) : "[Accessor omitted]"
  ]));
}

const logger = Object.fromEntries(["log", "warn", "error"].map((level) => [level, (...args) => {
  console[level](...args.map((value) => {
    const safe = safeLogValue(value);
    return typeof safe === "string" ? safe : inspect(safe, { depth: 5, customInspect: false, getters: false });
  }));
}]));

module.exports = { redactSecrets, publicErrorMessage, logger };
