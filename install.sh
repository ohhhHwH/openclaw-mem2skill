#!/bin/bash
git pull
npm pack
mv ./myorg-openclaw-mem2skill-1.0.0.tgz ~/workspace/agent/mem2skill.tgz
cd ~/workspace/agent
openclaw plugins install ./mem2skill.tgz
rm ./mem2skill.tgz
openclaw gateway restart