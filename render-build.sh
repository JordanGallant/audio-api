#!/bin/bash

# Update and install dependencies
apt-get update
apt-get install -y ffmpeg

# Proceed with your normal build process (e.g., npm install)
npm install
