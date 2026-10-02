'use strict';

/**
 * `npm run pcl:info` - report the detected PCL2 / Minecraft / Java environment and
 * the exact client command line PCL used last time.
 *
 * Useful when the agent cannot find the launcher, or when you want to confirm which
 * Java runtime will host the dedicated server.
 */

const { loadConfig } = require('../src/util/config');
const { environmentReport } = require('../src/pcl/launcher');
const { readLastLaunchCommand } = require('../src/pcl/detect');
const { resolveServerArtifact } = require('../src/server/serverManager');
const { Logger } = require('../src/util/logger');

(async () => {
  const cfg = loadConfig();
  const log = new Logger('pcl-info');
  const report = environmentReport(cfg);

  const line = (label, value) => process.stdout.write(`${label.padEnd(22)} ${value}\n`);
  process.stdout.write('\nPCL2 integration\n----------------\n');
  line('executable', report.pcl.executable || '(not found)');
  line('directory', report.pcl.directory || '-');
  line('PCL.ini version', report.pcl.activeVersionInIni || '-');
  line('last launch script', report.pcl.lastLaunchScript || '-');
  if (report.pcl.candidates.length > 1) {
    line('other candidates', report.pcl.candidates.slice(1).join(', '));
  }

  process.stdout.write('\nMinecraft\n---------\n');
  line('game directory', report.minecraft.dir || '(not found)');
  line('client version', report.minecraft.selectedClientVersion || '-');
  line('installed versions', report.minecraft.versions.join(', ') || '-');

  process.stdout.write('\nJava\n----\n');
  for (const j of report.java) {
    const marker = j.path === report.serverJava ? ' <- used for the server' : '';
    line(`java ${j.major ?? '?'}`, `${j.path}${marker}`);
  }
  if (!report.java.length) line('java', '(none detected)');

  const last = readLastLaunchCommand(report.pcl.lastLaunchScript ? { lastLaunchScript: report.pcl.lastLaunchScript } : {});
  if (last) {
    process.stdout.write('\nLast client launch (read from LatestLaunch.bat)\n-----------------------------------------------\n');
    line('workdir', last.workdir || '-');
    line('max heap', last.maxHeapMb ? `${last.maxHeapMb} MiB` : '-');
    const javaExe = (last.commandLine.match(/^"?([^"]*java(?:w)?\.exe)"?/i) || [])[1];
    line('java', javaExe || '-');
  }

  try {
    const artifact = await resolveServerArtifact(cfg.server.mcVersion, log);
    process.stdout.write('\nServer target\n-------------\n');
    line('version', artifact.mcVersion);
    line('required java', `${artifact.javaVersion}+`);
    line('download size', `${(artifact.size / 1048576).toFixed(1)} MiB`);
    line('sha1', artifact.sha1);
  } catch (err) {
    log.warn(`could not resolve the server artifact: ${err.message}`);
  }

  process.stdout.write('\nNote: PCL2 is a client launcher - the dedicated server is started\n');
  process.stdout.write('headlessly by this project using the java runtime shown above.\n\n');
})();
