#!/bin/bash

# MAX_RETRIES=3
# attempt=0
# while true; do
#   if git pull; then
#     echo "git pull 成功"
#     break
#   fi
#   attempt=$((attempt+1))
#   echo "git pull fail ${attempt} "
#   if [ "$attempt" -ge "$MAX_RETRIES" ]; then
#     echo "max try ${MAX_RETRIES} exit"
#     exit 1
#   fi
#   sleep 2
# done

npm pack
openclaw plugins uninstall memory2skill
openclaw plugins install ./memory2skill-1.0.0.tgz
rm ./memory2skill-1.0.0.tgz
bash /home/gem/workspace/agent/scripts/restart.sh