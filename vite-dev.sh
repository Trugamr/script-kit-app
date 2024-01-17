#!/bin/bash
# Start electron-vite dev and keep track of its process ID
MAIN_SKIP_SETUP=true electron-vite dev --l info &
pid=$!

# Create a process group
set -m
trap "echo 'Stopping electron-vite...'; pkill -x 'Electron'; pkill -f 'Electron'; wait $pid; exit" SIGINT

# Wait for the electron-vite process to finish
wait $pid
