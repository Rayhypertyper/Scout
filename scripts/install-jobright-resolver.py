"""Repair the scheduled resolver's runtime/log paths, preserving its calendar."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time

root = Path(__file__).resolve().parent.parent
agent = Path.home() / 'Library/LaunchAgents/com.internshipmatic.jobright.plist'
source = agent if agent.exists() else root / 'scripts/com.internshipmatic.jobright.plist'
with source.open('rb') as handle:
    config = plistlib.load(handle)
node = shutil.which('node')
worker = root / 'dist/src/jobrightResolver.js'
if not node or not worker.exists():
    raise SystemExit('Node.js 24+ and a successful npm run build are required.')
config['ProgramArguments'] = [node, str(worker), '--database', str(root / 'output/live/internships.db'), '--output-dir', str(root / 'output/live')]
config['WorkingDirectory'] = str(root)
config['ProcessType'] = 'Interactive'
log_directory = Path.home() / 'Library/Logs/Internshipmatic'
log_directory.mkdir(parents=True, exist_ok=True)
config['StandardOutPath'] = str(log_directory / 'jobright-resolver.stdout.log')
config['StandardErrorPath'] = str(log_directory / 'jobright-resolver.stderr.log')
agent.parent.mkdir(parents=True, exist_ok=True)
backup = agent.with_suffix('.plist.before-resolver-repair')
if agent.exists() and not backup.exists():
    shutil.copy2(agent, backup)
with agent.open('wb') as handle:
    plistlib.dump(config, handle, sort_keys=False)
domain = f'gui/{os.getuid()}'
service = f'{domain}/com.internshipmatic.jobright'
subprocess.run(['launchctl', 'bootout', service], check=False)
subprocess.run(['launchctl', 'enable', service], check=True)
for attempt in range(5):
    result = subprocess.run(['launchctl', 'bootstrap', domain, str(agent)], check=False)
    if result.returncode == 0:
        break
    if attempt == 4:
        result.check_returncode()
    time.sleep(2)
print(f'Installed {service}; calendar preserved, logs in {log_directory}.')
