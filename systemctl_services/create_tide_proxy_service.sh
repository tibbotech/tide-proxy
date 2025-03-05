#!/bin/bash

# PRECHECK USER
if [ "$(id -u)" -ne 0 ]; then
    echo -e '\r'
    echo "***${RED_FCOLOR}ERROR${RESET}: please run this script with 'sudo' or as 'root'"
    echo -e '\r'
    exit 1
fi


# IMPORT
source ./environment.sh


# FUNCTIONS
function Verify_If_Default_My_User_Is_Correct_Func() {
    echo -e "\r"

    while true; do
        read -p "---[VERIFICATION]: The current username is ${YELLOW_FCOLOR}${MY_USER}${RESET}, is that correct? (y/n)? " answer

        if [[ ${answer} == "y" ]] || [[ ${answer} == "Y" ]]; then
            break
        elif [[ ${answer} == "n" ]] || [[ ${answer} == "N" ]]; then
            echo -e "\r"
            echo "---[ADVICE]: Please update ${YELLOW_FCOLOR}MY_USER${RESET} parameter in ${GRAY_FCOLOR}environment.sh${RESET}."
            echo -e "\r"
            exit 0
        else
            echo -e "\r"
            echo "***[${RED_FCOLOR}ERROR${RESET}]: Please respond with ${GRAY_FCOLOR}y${RESET}, ${GRAY_FCOLOR}Y${RESET}, ${GRAY_FCOLOR}n${RESET}, or ${GRAY_FCOLOR}N${RESET}."
            echo -e "\r"
        fi
    done
}


function Get_Node_Fpath_Func() {
    # Set HOME_DIR
    local HOME_DIR="/home/${MY_USER}"

    # Try to detect the NVM directory
    if [ -z "${NVM_DIR}" ]; then
        export NVM_DIR="${HOME_DIR}/.nvm"
    fi

    # Load NVM if available
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        source "$NVM_DIR/nvm.sh"
    else
        echo -e "\r"
        echo "***[${RED_FCOLOR}ERROR${RESET}]: ${YELLOW_FCOLOR}nvm{RESET} is not installed or not found in ${GRAY_FCOLOR}NVM_DIR${RESET}."
        echo -e "\r"
        exit 1
    fi

    echo -e "\r"

    # Use the latest installed Node.js version
    nvm use node

    # Get the full path of 'node'
    node_fPath=$(which node)

    echo -e "\r"
    echo "---[STATUS] Using ${GRAY_FCOLOR}Node.js${RESET} at: ${GRAY_FCOLOR}$node_fPath${RESET}"
    echo -e "\r"
}



function Create_Service_Func() {
sudo bash -c "cat > ${TIDE_PROXY_SERVICE_FPATH}" <<EOL
[Unit]
Description=Start/Stop TIDE-PROXY SERVICE
After=network.target

[Service]
Type=simple
User=ubuntu

ExecStart=${node_fPath} ${SERVER_JS_FPATH}
ExecStop=/bin/kill -TERM $(pgrep -f "${SERVER_JS_FPATH}")

Restart=on-failure
RestartSec=10

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOL
}


# SUBROUTINES
Service_Handler() {
    # RELOAD DAEMON
    systemctl daemon-reload
    # ENABLE tide_proxy.service (if not done yet)
    systemctl enable ${TIDE_PROXY_SERVICE_FILENAME}
    # RESTART tide_proxy.service
    systemctl restart ${TIDE_PROXY_SERVICE_FILENAME}
    # CHECK STATUS tide_proxy.service
    systemctl status --no-pager ${TIDE_PROXY_SERVICE_FILENAME}
}

Main() {
    Verify_If_Default_My_User_Is_Correct_Func

    Get_Node_Fpath_Func

    Create_Service_Func

    Service_Handler
}


# EXECUTE MAIN
Main
