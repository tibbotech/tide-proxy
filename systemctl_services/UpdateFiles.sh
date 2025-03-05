#!/bin/bash
expectedFolder="systemctl_services"
currDir=$(pwd)
currFolder=$(basename "${currDir}")
srcFpath="${currDir}/tide_proxy.sh"
etc_systemd_system_dir="/etc/systemd/system"
usr_local_bin="/usr/local/bin"


# PRECHECK USER
if [ "$(id -u)" -ne 0 ]; then
    echo -e '\r'
    echo "***ERROR: please run this script with 'sudo' or as 'root'"
    echo -e '\r'
    exit 1
fi

# PRECHECK FOLDER
if [[ "${currFolder}" != "${expectedFolder}" ]]; then
    echo -e '\r'
    echo "***ERROR: please run this script from within folder '${expectedFolder}'"
    echo -e '\r'
    exit 1
fi

# COPY tide_proxy.service
if [[ -f "${srcFpath}" ]]; then
    cp ${srcFpath} ${etc_systemd_system_dir}
else
    echo -e '\r'
    echo "***ERROR: file not found in current directory '${currDir}'"
    echo "---INFO: please naviage to the correct directory containing file 'tide_proxy.service'"
    echo -e '\r'

    exit 1
fi


# RELOAD DAEMON
systemctl daemon-reload
# ENABLE tide_proxy.service (if not done yet)
systemctl enable tide_proxy.service
# RESTART tide_proxy.service
systemctl restart tide_proxy.service
# CHECK STATUS tide_proxy.service
systemctl status --no-pager tide_proxy.service
