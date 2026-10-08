const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { redactSecrets, publicErrorMessage, logger } = require("../src/security");
const original = process.env.SECURITY_TEST_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.SECURITY_TEST_API_KEY;
  else process.env.SECURITY_TEST_API_KEY = original;
});

test("redaction covers configured secrets, encoded values, auth headers and webhook query tokens", () => {
  const secret = "synthetic-secret/with+special=characters";
  process.env.SECURITY_TEST_API_KEY = secret;
  const result = redactSecrets(`${secret} ${encodeURIComponent(secret)} Bearer not-a-real-token https://example.invalid/webhook?token=not-a-real-webhook-token&kind=shipment`);
  assert.ok(!result.includes(secret));
  assert.ok(!result.includes(encodeURIComponent(secret)));
  assert.ok(!result.includes("not-a-real-token"));
  assert.ok(!result.includes("not-a-real-webhook-token"));
  assert.ok(result.includes("kind=shipment"));
});

test("logs redact nested error details without modifying the error or provider configuration", () => {
  process.env.SECURITY_TEST_API_KEY = "synthetic-private-provider-token";
  const error = Object.assign(new Error(`Provider rejected ${process.env.SECURITY_TEST_API_KEY}`), { request: { headers: { Authorization: `Bearer ${process.env.SECURITY_TEST_API_KEY}` } } });
  const capture = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try { logger.error("Provider failed", error); }
  finally { console.error = capture; }
  assert.ok(!lines.join("\n").includes(process.env.SECURITY_TEST_API_KEY));
  assert.ok(error.message.includes(process.env.SECURITY_TEST_API_KEY));
});

test("public errors hide secrets and authentication details but preserve address validation", () => {
  process.env.SECURITY_TEST_API_KEY = "synthetic-provider-private-token";
  assert.equal(publicErrorMessage(new Error(`Invalid ${process.env.SECURITY_TEST_API_KEY}`), "Try again"), "Try again");
  assert.equal(publicErrorMessage(new Error("Invalid API key"), "Try again"), "Try again");
  assert.equal(publicErrorMessage(Object.assign(new Error("Internal provider problem"), { statusCode: 503 }), "Try again"), "Try again");
  assert.equal(publicErrorMessage(Object.assign(new Error("State and ZIP code do not match."), { statusCode: 400 })), "State and ZIP code do not match.");
});

test("logging masks unconfigured credential fields and excludes SDK request objects", () => {
  const capture = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    logger.error({ headers: { Authorization: "unexpected-auth-value", cookie: "unexpected-cookie-value" }, apiKey: "unexpected-key-value", safe: "diagnostic" });
    logger.error(Object.assign(new Error("Request failed"), { request: { body: "unexpected-private-request" } }));
  } finally { console.error = capture; }
  assert.doesNotMatch(lines.join("\n"), /unexpected-/);
  assert.match(lines.join("\n"), /diagnostic/);
  assert.match(lines.join("\n"), /Request failed/);
});
