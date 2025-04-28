
# TIDE Proxy

This module provides commands control and monitor Tibbo Devices

## Command Line Start


## Proxy server with web config



## UFW
```
sudo ufw allow proto udp from any to any
```

## Local Web Server
```
allow tcp port 3005 to view local web server
```

## Zephyr Upload Methods

### Teensy

Download the Teensy Loader CLI from https://github.com/PaulStoffregen/teensy_loader_cli
Uncomment the relevant OS in the Makefile and run 'make' to compile the CLI (gcc or mingw required).
Add the compiled CLI to your PATH.


