// Run before every test:scripts lane. Never interpolate an unchecked value into Node options.
const value = process.env.SH_SCRIPTS_WORKERS;
if (value && (!/^[0-9]+$/.test(value) || BigInt(value) < 1n || BigInt(value) > 64n)) {
  console.error('SH_SCRIPTS_WORKERS must be a whole number from 1 to 64 (or unset/empty for the default).');
  process.exitCode = 1;
}
