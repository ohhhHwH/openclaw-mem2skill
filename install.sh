#!/bin/bash
git pull --force
npm pack
openclaw plugins install ./memory2skill-1.0.0.tgz
rm ./memory2skill-1.0.0.tgz
bash /home/gem/workspace/agent/scripts/restart.sh