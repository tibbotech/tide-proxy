#!/bin/bash

# COLOR CONSTANTS
GRAY_FCOLOR=$'\033[1;30m'
RED_FCOLOR=$'\033[0;31m' 
YELLOW_FCOLOR=$'\033[1;33m'
RESET=$'\033[0m'         # No Color (reset)


# PATH CONSTANTS
THIS_SCRIPT_FPATH=$(realpath "$0")  # Get the absolute full path of the script
THIS_SCRIPT_DIR=$(dirname "${THIS_SCRIPT_FPATH}")  # Get the script's directory
THIS_SCRIPT_PARENTDIR=$(dirname "${THIS_SCRIPT_DIR}")  # Get the parent directory of the script
THIS_SCRIPT_LIB_DIR="${THIS_SCRIPT_PARENTDIR}/lib"

ETC_SYSTEMD_SYSTEM_DIR="/etc/systemd/system"

SERVER_JS_FILENAME="server.js"
TIDE_PROXY_SERVICE_FILENAME="tide-proxy.service"

SERVER_JS_FPATH="${THIS_SCRIPT_LIB_DIR}/${SERVER_JS_FILENAME}"
TIDE_PROXY_SERVICE_FPATH="${ETC_SYSTEMD_SYSTEM_DIR}/${TIDE_PROXY_SERVICE_FILENAME}"


# VARIABLES
node_fPath=""


#***INPUT PARAMETERS***
MY_USER="ubuntu"
