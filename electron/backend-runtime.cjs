const fs = require('node:fs');
const path = require('node:path');

// A build may replace target/*.jar while the app is open. Java loads nested
// dependencies lazily, so it must run from its own immutable copy.
function prepareBackendRuntime(source, profileDirectory) {
  const cache = path.resolve(profileDirectory, 'backend-runtime');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'run-'));
  const jar = path.join(directory, 'duipai-backend.jar');
  try { fs.copyFileSync(source, jar, fs.constants.COPYFILE_EXCL); }
  catch (error) { fs.rmdirSync(directory); throw error; }
  return {
    jar,
    cleanup() {
      // Only remove the two exact paths created by this launch.
      try { fs.unlinkSync(jar); fs.rmdirSync(directory); } catch { /* OS may still hold a closing handle. */ }
    }
  };
}

module.exports = { prepareBackendRuntime };
