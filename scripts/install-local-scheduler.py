"""Install the supervised local scheduler, preserving existing launch agent settings."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time

root = Path(__file__).resolve().parent.parent
agent = Path.home() / 'Library/LaunchAgents/com.internshipmatic.scout.plist'
source = agent if agent.exists() else root / 'scripts/com.internshipmatic.scout.plist'
with source.open('rb') as handle:
    config = plistlib.load(handle)
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js 24 or later is required.')
worker = root / 'dist/src/scheduler.js'
if not worker.exists():
    raise SystemExit('Build dist/src/scheduler.js before installing.')
config['ProgramArguments'] = [node, str(worker), '--database', str(root / 'output/live/internships.db'), '--output-dir', str(root / 'output/live')]
config['WorkingDirectory'] = str(root)
config.pop('StartCalendarInterval', None)
config.pop('StartInterval', None)
config.update(RunAtLoad=True, KeepAlive=True, ThrottleInterval=60)
for key in ['StandardOutPath', 'StandardErrorPath']:
    Path(config[key]).parent.mkdir(parents=True, exist_ok=True)
agent.parent.mkdir(parents=True, exist_ok=True)
backup = agent.with_suffix('.plist.before-supervised-scheduler')
if agent.exists() and not backup.exists():
    shutil.copy2(agent, backup)
with agent.open('wb') as handle:
    plistlib.dump(config, handle, sort_keys=False)
domain = f'gui/{os.getuid()}'
service = f'{domain}/com.internshipmatic.scout'
subprocess.run(['launchctl', 'bootout', service], check=False)
subprocess.run(['launchctl', 'enable', service], check=True)
# bootout can return before the old service has fully left its bootstrap domain.
for attempt in range(5):
    result = subprocess.run(['launchctl', 'bootstrap', domain, str(agent)], check=False)
    if result.returncode == 0:
        break
    if attempt == 4:
        result.check_returncode()
    time.sleep(2)
subprocess.run(['launchctl', 'print', service], check=True)
