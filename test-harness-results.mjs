export function reportHarnessResults(pass, fail, failures, log = console.log) {
  log(`\n=== RESULTS: ${pass} passed, ${fail} failed out of ${pass + fail} tests ===\n`);
  if (failures.length) {
    log('FAILURES:');
    failures.forEach(failure => log(' -', failure));
  }
  if (fail > 0 || failures.length > 0) process.exitCode = 1;
}
